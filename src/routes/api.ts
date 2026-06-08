import { Router } from 'express';
import { getPendingChanges, getPendingChangeById, updatePendingChangeStatus, deletePendingChange } from '../db';
import { executeChange } from '../utils/executor';
import { invalidateJournalsCache } from './company';
import { tryAcquire, release } from '../utils/locks';

const router = Router();

// List all pending changes
router.get('/changes', async (req, res) => {
  try {
    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const changes = await getPendingChanges(status);
    res.json({ success: true, changes });
  } catch (error) {
    console.error('Error fetching changes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch changes' });
  }
});

// Get a specific change
router.get('/changes/:id', async (req, res) => {
  try {
    const change = await getPendingChangeById(req.params.id);
    if (!change) {
      return res.status(404).json({ success: false, error: 'Change not found' });
    }
    res.json({ success: true, change });
  } catch (error) {
    console.error('Error fetching change:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch change' });
  }
});

// Approve a change
router.post('/changes/:id/approve', async (req, res) => {
  const lockKey = `change:${req.params.id}`;
  // Serialize approval of a given change so two concurrent requests can't both
  // pass the pending-status check and execute the underlying write twice.
  if (!tryAcquire(lockKey)) {
    return res.status(409).json({
      success: false,
      error: 'Change is already being processed',
    });
  }

  try {
    const change = await getPendingChangeById(req.params.id);
    if (!change) {
      return res.status(404).json({ success: false, error: 'Change not found' });
    }

    if (change.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Change is already ${change.status}`
      });
    }

    const resolvedBy = req.body.resolvedBy || 'system';

    // Execute the change
    const result = await executeChange(change);

    // Update status
    await updatePendingChangeStatus(
      change.id,
      'approved',
      resolvedBy,
      JSON.stringify(result)
    );

    // A write may have created new journals; refresh cached balances next read.
    invalidateJournalsCache();

    res.json({
      success: true,
      message: 'Change approved and executed',
      result,
    });
  } catch (error) {
    console.error('Error approving change:', error);

    // Update status with error
    await updatePendingChangeStatus(
      req.params.id,
      'rejected',
      req.body.resolvedBy || 'system',
      undefined,
      error instanceof Error ? error.message : 'Unknown error'
    );

    res.status(500).json({
      success: false,
      error: 'Failed to approve change',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    release(lockKey);
  }
});

// Reject a change
router.post('/changes/:id/reject', async (req, res) => {
  const lockKey = `change:${req.params.id}`;
  // Serialize with approval so a reject can't race an in-flight approve of the
  // same change and flip its status after the write has already been executed.
  if (!tryAcquire(lockKey)) {
    return res.status(409).json({
      success: false,
      error: 'Change is already being processed',
    });
  }

  try {
    const change = await getPendingChangeById(req.params.id);
    if (!change) {
      return res.status(404).json({ success: false, error: 'Change not found' });
    }

    if (change.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Change is already ${change.status}`
      });
    }

    const resolvedBy = req.body.resolvedBy || 'system';
    const reason = req.body.reason;

    await updatePendingChangeStatus(
      change.id,
      'rejected',
      resolvedBy,
      undefined,
      reason
    );

    res.json({
      success: true,
      message: 'Change rejected',
    });
  } catch (error) {
    console.error('Error rejecting change:', error);
    res.status(500).json({ success: false, error: 'Failed to reject change' });
  } finally {
    release(lockKey);
  }
});

// Delete a change
router.delete('/changes/:id', async (req, res) => {
  try {
    await deletePendingChange(req.params.id);
    res.json({ success: true, message: 'Change deleted' });
  } catch (error) {
    console.error('Error deleting change:', error);
    res.status(500).json({ success: false, error: 'Failed to delete change' });
  }
});

// Get statistics
router.get('/stats', async (req, res) => {
  try {
    const pending = await getPendingChanges('pending');
    const approved = await getPendingChanges('approved');
    const rejected = await getPendingChanges('rejected');
    
    res.json({
      success: true,
      stats: {
        pending: pending.length,
        approved: approved.length,
        rejected: rejected.length,
        total: pending.length + approved.length + rejected.length,
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

export default router;
