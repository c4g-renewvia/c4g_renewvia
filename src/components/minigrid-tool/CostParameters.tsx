'use client';

import React from 'react';

interface CostParametersProps {
  poleCost: number;
  lowVoltageCost: number;
  highVoltageCost: number;
  onPoleCostChange: (_value: number) => void;
  onLowVoltageCostChange: (_value: number) => void;
  onHighVoltageCostChange: (_value: number) => void;
  onRandomCosts: () => void;
}

export default function CostParameters({
  poleCost,
  lowVoltageCost,
  highVoltageCost,
  onPoleCostChange,
  onLowVoltageCostChange,
  onHighVoltageCostChange,
  onRandomCosts,
}: CostParametersProps) {
  return (
    <div className='flex flex-col rounded-xl border border-zinc-200 bg-white p-7 backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/50'>
      <h3 className='mb-5 text-xl font-semibold text-zinc-900 dark:text-white'>
        Cost Parameters
      </h3>

      <div className='grid gap-6 sm:grid-cols-3'>
        <div>
          <label className='mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300'>
            Pole Cost ($)
          </label>
          <input
            type='number'
            step='0.01'
            min='0'
            value={poleCost}
            onChange={(e) => onPoleCostChange(parseFloat(e.target.value) || 0)}
            className='w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white'
          />
        </div>

        <div>
          <label className='mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300'>
            Low Voltage ($/m)
          </label>
          <input
            type='number'
            step='0.01'
            min='0'
            value={lowVoltageCost}
            onChange={(e) =>
              onLowVoltageCostChange(parseFloat(e.target.value) || 0)
            }
            className='w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white'
          />
        </div>

        <div>
          <label className='mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300'>
            High Voltage ($/m)
          </label>
          <input
            type='number'
            step='0.01'
            min='0'
            value={highVoltageCost}
            onChange={(e) =>
              onHighVoltageCostChange(parseFloat(e.target.value) || 0)
            }
            className='w-full rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white'
          />
        </div>
      </div>

      <button
        onClick={onRandomCosts}
        className='mt-5 text-sm text-emerald-600 transition-colors hover:text-emerald-700 hover:underline dark:text-emerald-400 dark:hover:text-emerald-300'
      >
        Use realistic random values
      </button>
    </div>
  );
}
