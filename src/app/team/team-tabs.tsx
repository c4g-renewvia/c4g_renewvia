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

  return (
    <Tabs value={pathname} className='w-full'>
      {/* Desktop: Horizontal tabs */}
      <TabsList className='bg-muted text-muted-foreground hidden h-10 w-full max-w-full items-center justify-center overflow-x-auto rounded-md p-1 lg:inline-flex'>
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

      {/* Mobile: Vertical stacked tabs */}
      <div className='bg-muted flex flex-col gap-1 rounded-md p-1 lg:hidden'>
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
    </Tabs>
  );
}
