import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Project Demo • Renewvia',
  description:
    'Live demo & interactive showcase – Solar Mini-Grid Powerline Optimization',
  icons: { icon: '/favicon.ico' },
};

export default function DemoPage() {
  return (
    <div className='min-h-screen overflow-hidden bg-zinc-950 text-white'>
      {/* Hero Header – consistent with other project pages */}
      <header className='relative bg-linear-to-br from-emerald-600 via-teal-700 to-cyan-700 py-28 text-center md:py-32'>
        <div className='absolute inset-0 bg-[radial-gradient(#ffffff10_1px,transparent_1px)] bg-size-[40px_40px]' />
        <div className='relative mx-auto max-w-6xl px-6'>
          <div className='mb-8 inline-flex items-center gap-3 rounded-full border border-white/20 bg-white/10 px-6 py-2 backdrop-blur-md'>
            <span className='text-2xl'>🚀</span>
            <span className='text-sm font-medium tracking-[4px] uppercase'>
              Renewvia Energy
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

      {/* Main content area */}
      <div className='mx-auto max-w-6xl space-y-20 px-6 py-20 md:py-28'>
        {/* Introduction / Coming Soon Block */}
        <div className='text-center'>
          <div className='inline-block w-full max-w-5xl rounded-3xl border border-zinc-800 bg-zinc-900/70 px-10 py-16 md:py-20'>
            <div className='mb-8 text-8xl'>⚡</div>
            <h2 className='mb-8 text-4xl font-bold tracking-tight md:text-5xl'>
              Interactive Project Demo
            </h2>
            <p className='mx-auto mb-12 max-w-4xl text-xl leading-relaxed text-zinc-300 md:text-2xl'>
              This page will showcase a live or interactive demonstration of the
              pole-and-line placement optimization algorithm developed for
              Renewvia’s solar mini-grids.
            </p>

            <div className='mx-auto mb-16 grid max-w-5xl grid-cols-1 gap-8 text-left md:grid-cols-3'>
              <div className='rounded-2xl border border-zinc-700 bg-zinc-800/50 p-8'>
                <h3 className='mb-4 text-2xl font-semibold text-emerald-300'>
                  What You&apos;ll See
                </h3>
                <ul className='space-y-3 text-zinc-300'>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Input map with user locations & source</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Computed optimal pole & line layout</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>MST vs Steiner Tree comparison</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Cost, voltage drop & metrics</span>
                  </li>
                </ul>
              </div>

              <div className='rounded-2xl border border-zinc-700 bg-zinc-800/50 p-8'>
                <h3 className='mb-4 text-2xl font-semibold text-emerald-300'>
                  Current Features
                </h3>
                <ul className='space-y-3 text-zinc-300'>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Basic MST implementation</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Simple visualization layer</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Cost & distance calculations</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Sample datasets for testing</span>
                  </li>
                </ul>
              </div>

              <div className='rounded-2xl border border-zinc-700 bg-zinc-800/50 p-8'>
                <h3 className='mb-4 text-2xl font-semibold text-emerald-300'>
                  Next Milestones
                </h3>
                <ul className='space-y-3 text-zinc-300'>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Steiner Tree integration</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Satellite overlay support</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Interactive parameter tuning</span>
                  </li>
                  <li className='flex items-start gap-3'>
                    <span className='mt-1 text-emerald-400'>→</span>
                    <span>Real Renewvia dataset demo</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className='mx-auto max-w-3xl text-lg text-zinc-400'>
              <p className='mb-6'>
                The demo is under active development. A working prototype will
                be embedded or linked here soon.
              </p>
              <p>
                Expected availability: March–April 2026 (post-algorithm
                refinement & testing phase)
              </p>
            </div>
          </div>
        </div>

        {/* Small teaser / context */}
        <div className='mx-auto max-w-4xl text-center text-lg text-zinc-400'>
          <p>
            From heuristic-based mini-grid design → algorithmic optimization →
            real-world impact in remote East African communities.
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className='border-t border-zinc-800 py-12 text-center text-sm text-zinc-500'>
        <p>© 2026 Renewvia • CS 6150 Computing For Good • Project Demo</p>
      </footer>
    </div>
  );
}
