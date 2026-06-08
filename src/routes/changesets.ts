import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  createChangeset,
  getChangesets,
  getChangesetWithChanges,
  updateChangesetStatus,
  updatePendingChangeStatus,
  deleteChangeset,
  deleteChangesets,
  moveChangesToChangeset,
} from '../db';
import { executeChange } from '../utils/executor';
import { invalidateJournalsCache } from './company';
import { tryAcquire, release } from '../utils/locks';

const router = Router();

// List all changesets
router.get('/changesets', async (req, res) => {
  try {
    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const changesets = await getChangesets(status);
    res.json({ success: true, changesets });
  } catch (error) {
    console.error('Error fetching changesets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch changesets' });
  }
});

// Get a specific changeset with all its changes
router.get('/changesets/:id', async (req, res) => {
  try {
    const result = await getChangesetWithChanges(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Changeset not found' });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching changeset:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch changeset' });
  }
});

// Create a new changeset
router.post('/changesets', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Changeset name is required' });
    }
    
    const changeset = {
      id: uuidv4(),
      name: name.trim(),
      description: description?.trim(),
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    
    await createChangeset(changeset);
    
    res.status(201).json({ 
      success: true, 
      message: 'Changeset created',
      changeset,
    });
  } catch (error) {
    console.error('Error creating changeset:', error);
    res.status(500).json({ success: false, error: 'Failed to create changeset' });
  }
});

// Approve all changes in a changeset
router.post('/changesets/:id/approve', async (req, res) => {
  const lockKey = `changeset:${req.params.id}`;
  // Serialize approval of a given changeset so two concurrent requests can't both
  // pass the pending-status check and execute the same changes twice.
  if (!tryAcquire(lockKey)) {
    return res.status(409).json({
      success: false,
      error: 'Changeset is already being processed',
    });
  }

  try {
    const result = await getChangesetWithChanges(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Changeset not found' });
    }

    const { changeset, changes } = result;

    if (changeset.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Changeset is already ${changeset.status}`
      });
    }

    const resolvedBy = req.body.resolvedBy || 'system';
    const results: { changeId: string; success: boolean; error?: string }[] = [];
    let hasErrors = false;

    // Execute all pending changes
    for (const change of changes) {
      if (change.status !== 'pending') continue;

      try {
        const execResult = await executeChange(change);
        await updatePendingChangeStatus(
          change.id,
          'approved',
          resolvedBy,
          JSON.stringify(execResult)
        );
        results.push({ changeId: change.id, success: true });
      } catch (error) {
        hasErrors = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await updatePendingChangeStatus(
          change.id,
          'rejected',
          resolvedBy,
          undefined,
          errorMsg
        );
        results.push({ changeId: change.id, success: false, error: errorMsg });
      }
    }

    // Update changeset status
    const finalStatus = hasErrors ? 'rejected' : 'approved';
    await updateChangesetStatus(changeset.id, finalStatus, resolvedBy);

    // A write may have created new journals; drop the cached journal list so
    // balance views reflect the change immediately.
    invalidateJournalsCache();

    res.json({
      success: !hasErrors,
      message: hasErrors ? 'Some changes failed' : 'All changes approved and executed',
      changesetId: changeset.id,
      results,
    });
  } catch (error) {
    console.error('Error approving changeset:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to approve changeset',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    release(lockKey);
  }
});

// Reject all changes in a changeset
router.post('/changesets/:id/reject', async (req, res) => {
  try {
    const result = await getChangesetWithChanges(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Changeset not found' });
    }
    
    const { changeset, changes } = result;
    
    if (changeset.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: `Changeset is already ${changeset.status}` 
      });
    }
    
    const resolvedBy = req.body.resolvedBy || 'system';
    const reason = req.body.reason;
    
    // Reject all pending changes
    for (const change of changes) {
      if (change.status === 'pending') {
        await updatePendingChangeStatus(
          change.id,
          'rejected',
          resolvedBy,
          undefined,
          reason || 'Changeset rejected'
        );
      }
    }
    
    // Update changeset status
    await updateChangesetStatus(changeset.id, 'rejected', resolvedBy);
    
    res.json({ 
      success: true, 
      message: 'Changeset rejected',
      changesetId: changeset.id,
    });
  } catch (error) {
    console.error('Error rejecting changeset:', error);
    res.status(500).json({ success: false, error: 'Failed to reject changeset' });
  }
});

// Add changes to a changeset
router.post('/changesets/:id/changes', async (req, res) => {
  try {
    const { changeIds } = req.body;
    
    if (!Array.isArray(changeIds) || changeIds.length === 0) {
      return res.status(400).json({ success: false, error: 'changeIds array is required' });
    }
    
    const changeset = await getChangesetWithChanges(req.params.id);
    if (!changeset) {
      return res.status(404).json({ success: false, error: 'Changeset not found' });
    }
    
    if (changeset.changeset.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot add changes to a non-pending changeset' 
      });
    }
    
    // Move changes to this changeset
    await moveChangesToChangeset(changeIds, req.params.id);
    
    res.json({ 
      success: true, 
      message: `Added ${changeIds.length} changes to changeset`,
    });
  } catch (error) {
    console.error('Error adding changes to changeset:', error);
    res.status(500).json({ success: false, error: 'Failed to add changes to changeset' });
  }
});

// Delete a changeset
router.delete('/changesets/:id', async (req, res) => {
  try {
    await deleteChangeset(req.params.id);
    res.json({ success: true, message: 'Changeset deleted' });
  } catch (error) {
    console.error('Error deleting changeset:', error);
    res.status(500).json({ success: false, error: 'Failed to delete changeset' });
  }
});

// Delete all changesets (optionally by status)
router.delete('/changesets', async (req, res) => {
  try {
    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const deletedCount = await deleteChangesets(status);

    res.json({
      success: true,
      message: `Deleted ${deletedCount} changeset${deletedCount === 1 ? '' : 's'}`,
      deletedCount,
      scope: status || 'all',
    });
  } catch (error) {
    console.error('Error deleting changesets:', error);
    res.status(500).json({ success: false, error: 'Failed to delete changesets' });
  }
});

export default router;
