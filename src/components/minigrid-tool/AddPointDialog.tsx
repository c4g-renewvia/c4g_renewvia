// components/minigrid/AddPointDialog.tsx
'use client';

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface AddPointDialogProps {
  isOpen: boolean;
  onOpenChange: (_open: boolean) => void;
  newPointDetails: { name: string; type: 'source' | 'terminal' | 'pole' };
  onNewPointDetailsChange: (_details: {
    name: string;
    type: 'source' | 'terminal' | 'pole';
  }) => void;
  onConfirm: () => void;
}

export default function AddPointDialog({
  isOpen,
  onOpenChange,
  newPointDetails,
  onNewPointDetailsChange,
  onConfirm,
}: AddPointDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className='border-zinc-800 bg-zinc-900 text-white sm:max-w-106.25'>
        <DialogHeader>
          <DialogTitle>Add New Point</DialogTitle>
          <DialogDescription className='text-zinc-400'>
            Set the details for the location you just clicked.
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-4'>
          <div className='grid grid-cols-4 items-center gap-4'>
            <label className='text-right text-sm'>Name</label>
            <input
              value={newPointDetails.name}
              onChange={(e) =>
                onNewPointDetailsChange({
                  ...newPointDetails,
                  name: e.target.value,
                })
              }
              className='col-span-3 rounded-md border-zinc-700 bg-zinc-800 px-3 py-2 text-sm'
            />
          </div>
          <div className='grid grid-cols-4 items-center gap-4'>
            <label className='text-right text-sm'>Type</label>
            <select
              value={newPointDetails.type}
              onChange={(e) =>
                onNewPointDetailsChange({
                  ...newPointDetails,
                  type: e.target.value as 'source' | 'terminal' | 'pole',
                })
              }
              className='col-span-3 rounded-md border-zinc-700 bg-zinc-800 px-3 py-2 text-sm'
            >
              <option value='terminal'>Terminal</option>
              <option value='source'>Source</option>
              <option value='pole'>Pole</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className='px-4 py-2 text-sm text-zinc-400 hover:text-white'
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className='rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-700'
          >
            Add Point
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
