import { AppMock } from './AppMock'
import { IconArrow } from './icons'
import { useReveal } from '../useReveal'

export function Hero() {
  const { ref, shown } = useReveal<HTMLDivElement>({ threshold: 0.05 })

  return (
    <section id="top" className="relative px-4 pt-32 sm:pt-36">
      <div className="mx-auto max-w-5xl text-center">
        <div
          ref={ref}
          className={`reveal ${shown ? 'in' : ''} mx-auto flex max-w-fit items-center gap-2 rounded-full border border-black/[0.06] bg-white/60 px-3.5 py-1.5 text-[12.5px] font-medium text-ink-500 backdrop-blur`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse-dot" />
          A personal work agent — now in early access
        </div>

        <h1
          className={`reveal ${shown ? 'in' : ''} mx-auto mt-6 max-w-3xl text-balance text-[40px] font-bold leading-[1.05] tracking-[-0.03em] text-ink-900 sm:text-[58px]`}
          style={{ transitionDelay: '60ms' }}
        >
          Your work, <span className="brand-gradient-text">seen whole</span>.
          <br className="hidden sm:block" /> Handled like you would.
        </h1>

        <p
          className={`reveal ${shown ? 'in' : ''} mx-auto mt-6 max-w-2xl text-balance text-[16.5px] font-medium leading-relaxed text-ink-600 sm:text-[18.5px]`}
          style={{ transitionDelay: '120ms' }}
        >
          Sees the full picture · learns as you work · helps you get things done —
          even while you're away, and wherever you are.
        </p>

        <div
          className={`reveal ${shown ? 'in' : ''} mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row`}
          style={{ transitionDelay: '180ms' }}
        >
          <a
            href="#download"
            className="btn-primary group flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-[15px] font-semibold sm:w-auto"
          >
            Download for free
            <IconArrow
              width={18}
              height={18}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </a>
          <a
            href="#preview"
            className="btn-ghost flex w-full items-center justify-center rounded-xl px-6 py-3 text-[15px] font-semibold sm:w-auto"
          >
            See it in action
          </a>
        </div>
      </div>

      {/* Product visual */}
      <div className="mx-auto mt-16 max-w-5xl">
        <div
          className={`reveal ${shown ? 'in' : ''} animate-float`}
          style={{ transitionDelay: '280ms' }}
        >
          <div className="relative">
            {/* glow */}
            <div
              aria-hidden
              className="absolute -inset-x-10 -top-10 bottom-0 -z-10 rounded-[40px] bg-gradient-to-b from-brand-400/30 via-brand-500/10 to-transparent blur-3xl"
            />
            <AppMock />
          </div>
        </div>
      </div>

      {/* Trust strip */}
      <div className="mx-auto mt-14 max-w-3xl">
        <p className="text-center text-[12px] font-medium uppercase tracking-[0.14em] text-ink-300">
          Connects the tools you already live in
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[14px] font-semibold text-ink-400">
          {['Outlook', 'Microsoft Teams', 'GitHub', 'Calendar'].map((t) => (
            <span key={t} className="opacity-70 transition-opacity hover:opacity-100">
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
