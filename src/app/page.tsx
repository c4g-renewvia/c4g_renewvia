export default function Home() {
  return (
    <main className='relative isolate overflow-hidden bg-white dark:bg-slate-950'>
      {/* Background */}
      <div className='pointer-events-none absolute inset-0 -z-10'>
        <div className='absolute inset-0 bg-gradient-to-b from-slate-100 via-white to-slate-50 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900' />
        <div className='absolute -top-48 left-1/2 h-112 w-4xl -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl dark:bg-emerald-500/20' />
        <div className='absolute top-40 left-1/2 h-88 w-4xl -translate-x-1/2 rounded-full bg-sky-500/10 blur-3xl dark:bg-sky-500/15' />
      </div>

      <section className='mx-auto flex min-h-[calc(100dvh-8.4rem)] max-w-5xl flex-col items-center justify-center px-6 py-16 text-center'>
        {/* Badge */}
        <div className='mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-white/80'>
          <span className='h-2 w-2 rounded-full bg-emerald-500' />
          Georgia Tech • CS 6150 Computing for Good • Spring 2026
        </div>

        {/* Title */}
        <h1 className='text-4xl font-semibold tracking-tight text-balance text-slate-900 sm:text-6xl dark:text-white'>
          Renewvia Mini-Grid{' '}
          <span className='bg-gradient-to-r from-emerald-600 via-sky-600 to-violet-600 bg-clip-text text-transparent dark:from-emerald-300 dark:via-sky-300 dark:to-violet-300'>
            Optimization
          </span>{' '}
          Project
        </h1>

        {/* Subtitle */}
        <p className='mt-6 max-w-2xl text-base leading-relaxed text-pretty text-slate-600 sm:text-lg dark:text-white/70'>
          Georgia Tech - Computing for Good - Volunteer Project <br />
          <br />
          Improving planning and performance for real-world mini-grid
          deployments empowering Renewvia to service African communities more
          effectively
        </p>

        {/* Actions */}
        <div className='mt-10 flex flex-col items-center gap-3 sm:flex-row'>
          <a
            href='/team'
            className='inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 focus:ring-2 focus:ring-slate-900/30 focus:outline-none dark:bg-white dark:text-slate-900 dark:hover:bg-white/90'
          >
            Meet the team
          </a>
          <a
            href='/team/project-description'
            className='inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 backdrop-blur transition hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 focus:outline-none dark:border-white/15 dark:bg-white/5 dark:text-white/90 dark:hover:bg-white/10'
          >
            Read project description
          </a>
          <a
            href='/team/demo'
            className='inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 backdrop-blur transition hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 focus:outline-none dark:border-white/15 dark:bg-black/100 dark:text-white/90 dark:hover:bg-white/10'
          >
            See the Demo
          </a>
        </div>

        <div className='mt-10 flex flex-col items-center gap-3 sm:flex-row'>
          <a
            href='/minigrid-tool'
            className='inline-flex items-center justify-center rounded-xl bg-emerald-600 px-8 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition-all hover:bg-emerald-500 hover:shadow-xl hover:shadow-emerald-500/40 focus:ring-2 focus:ring-emerald-400/50 focus:outline-none active:scale-[0.985]'
          >
            Use the Tool
          </a>
        </div>

        {/* Bottom card */}
        <div className='mt-12 w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 text-left text-slate-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-white/80'>
          <div className='grid gap-4 sm:grid-cols-3'>
            <div>
              <div className='text-xs tracking-wide text-slate-500 uppercase dark:text-white/50'>
                Focus
              </div>
              <div className='mt-1 font-medium text-slate-900 dark:text-white'>
                Tree Solver
              </div>
            </div>
            <div>
              <div className='text-xs tracking-wide text-slate-500 uppercase dark:text-white/50'>
                Partner
              </div>
              <div className='mt-1 font-medium text-slate-900 dark:text-white'>
                Renewvia
              </div>
            </div>
            <div>
              <div className='text-xs tracking-wide text-slate-500 uppercase dark:text-white/50'>
                Term
              </div>
              <div className='mt-1 font-medium text-slate-900 dark:text-white'>
                Spring 2026
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
