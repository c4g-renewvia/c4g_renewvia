import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Project Demo • Renewvia',
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
