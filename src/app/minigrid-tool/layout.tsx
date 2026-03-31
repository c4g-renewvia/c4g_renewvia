import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Mini-Grid Solver Tool',
  description: 'Solar Mini-Grid Powerline Solver Tool',
  icons: { icon: '/favicon.ico' },
};

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
