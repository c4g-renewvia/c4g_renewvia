'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const tabs = [
  { name: 'Team', href: '/team' },
  { name: 'Project Description', href: '/team/project-description' },
  { name: 'Project Goal', href: '/team/project-goal' },
  { name: 'Lighthouse Report', href: '/team/lighthouse-report' },
  { name: 'Presentation Slides', href: '/team/presentation-slides' },
  { name: 'Demo', href: '/team/demo' },
];

export function TeamTabs() {
  const pathname = usePathname();
  const isToolPage = pathname === '/minigrid-tool';

  return (
    <div className='w-full'>
      {/* Desktop Layout */}
      <div className='hidden items-center justify-between gap-4 lg:flex'>
        {/* Regular Tabs */}
        <Tabs value={pathname} className='flex-1'>
          <TabsList className='bg-muted text-muted-foreground h-10 w-full max-w-full items-center justify-start overflow-x-auto rounded-md p-1'>
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.href}
                value={tab.href}
                className='data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center rounded-sm px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-all data-[state=active]:shadow-sm'
                asChild
              >
                <Link href={tab.href}>{tab.name}</Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Detached Optimization Tool Button */}
        <Link
          href='/minigrid-tool'
          className={`inline-flex items-center justify-center rounded-xl bg-emerald-500 px-6 py-2.5 text-sm font-semibold text-white shadow-sm shadow-emerald-500/30 transition-all hover:bg-emerald-400 hover:shadow-md hover:shadow-emerald-500/40 focus:ring-2 focus:ring-emerald-400/50 focus:outline-none active:scale-[0.985] ${
            isToolPage ? 'ring-2 ring-emerald-400/50' : ''
          }`}
        >
          Optimization Tool
        </Link>
      </div>

      {/* Mobile Layout */}
      <div className='space-y-3 lg:hidden'>
        {/* Regular Tabs - Vertical */}
        <div className='bg-muted flex flex-col gap-1 rounded-md p-1'>
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex items-center rounded-md px-4 py-3 text-sm font-medium transition-all ${
                pathname === tab.href
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
              }`}
            >
              {tab.name}
            </Link>
          ))}
        </div>

        {/* Detached Optimization Tool Button - Mobile */}
        <Link
          href='/minigrid-tool'
          className={`flex w-full items-center justify-center rounded-xl bg-emerald-500 px-6 py-3.5 text-sm font-semibold text-white shadow-sm shadow-emerald-500/30 transition-all hover:bg-emerald-400 hover:shadow-md hover:shadow-emerald-500/40 focus:ring-2 focus:ring-emerald-400/50 focus:outline-none active:scale-[0.985] ${
            isToolPage ? 'ring-2 ring-emerald-400/50' : ''
          }`}
        >
          Optimization Tool
        </Link>
      </div>
    </div>
  );
}
