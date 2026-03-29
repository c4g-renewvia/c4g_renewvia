import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Demo • Renewvia',
  description: 'Project Demo Video – CS 6150 Computing For Good',
  icons: { icon: '/favicon.ico' },
};

export default function ProjectDemoPage() {
  return (
    <div className='min-h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-white'>
      {/* Hero Header – consistent style across the site */}
      <header className='relative bg-gradient-to-br from-emerald-600 via-teal-700 to-cyan-700 py-28 text-center text-white md:py-32'>
        <div className='absolute inset-0 bg-[radial-gradient(#ffffff10_1px,transparent_1px)] bg-[size:40px_40px]' />
        <div className='relative mx-auto max-w-6xl px-6'>
          <div className='mb-8 inline-flex items-center gap-3 rounded-full border border-white/20 bg-white/10 px-6 py-2 backdrop-blur-md'>
            <span className='text-2xl'>📽️</span>
            <span className='text-sm font-medium tracking-[4px] uppercase'>
              C4G - Renewvia Energy Project Demo
            </span>
          </div>

          <h1 className='mb-6 text-6xl font-bold tracking-tighter md:text-7xl lg:text-8xl'>
            Project Demo
          </h1>
          <p className='mb-10 text-3xl font-light text-emerald-100 md:text-4xl lg:text-5xl'>
            Solar Mini-Grid Powerline Distribution Networks
          </p>
        </div>
      </header>

      {/* Spring 2026 Demo Section with embedded Google Drive video */}
      <section className='mx-auto max-w-6xl border-t border-zinc-200 px-6 py-20 md:py-28 dark:border-zinc-800'>
        <div className='mb-12 text-center'>
          <h2 className='text-5xl font-bold tracking-tight text-emerald-600 md:text-6xl dark:text-emerald-400'>
            Spring 2026 Demo
          </h2>
        </div>

        <div className='mx-auto max-w-5xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900/50'>
          <div className='relative pt-[56.25%]'>
            {' '}
            {/* 16:9 aspect ratio */}
            <iframe
              src='https://drive.google.com/file/d/1fgy8RvdnKWG-CWk9j4wBESL_BYO3leUz/preview'
              allow='autoplay'
              className='absolute inset-0 h-full w-full'
              title='Spring 2026 Renewvia Project Video'
              allowFullScreen
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className='border-t border-zinc-200 bg-white py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400'>
        <p>© 2026 • CS 6150 Computing For Good • Renewvia Project Demo</p>
      </footer>
    </div>
  );
}
