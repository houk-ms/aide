import { IconLayers, IconBrain, IconSpark } from './icons'
import { useReveal } from '../useReveal'
import type { ReactNode } from 'react'

const features = [
  {
    icon: <IconLayers width={22} height={22} />,
    kicker: 'Aggregate',
    title: 'Every task, one surface',
    body: 'Email, Teams threads, GitHub issues, meeting follow-ups — Aide gathers them automatically and triages what actually needs you.',
    points: ['Inbox & chat capture', 'Auto-triage by priority', 'No more tab-hopping'],
  },
  {
    icon: <IconBrain width={22} height={22} />,
    kicker: 'Understand',
    title: 'Context that compounds',
    body: 'Aide remembers your projects, people, and preferences. The more you work, the more it knows — and the less you have to explain.',
    points: ['Persistent memory', 'Knows your tone & style', 'Connects the dots across tools'],
  },
  {
    icon: <IconSpark width={22} height={22} />,
    kicker: 'Act',
    title: 'Done the way you would',
    body: 'Draft the reply, summarize the thread, open the PR review — and when a system has no API, Aide drives the browser itself. It does the work and asks before anything leaves your hands.',
    points: ['Drafts, reviews & PRs', 'Operates web apps directly', 'Always asks before sending'],
  },
]

export function Features() {
  return (
    <section id="features" className="relative px-4 py-28 sm:py-36">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          kicker="What it does"
          title="See the whole picture. Move on the parts that matter."
          subtitle="Three capabilities working as one — so your day runs without the friction."
        />

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
          {features.map((f, i) => (
            <FeatureCard key={f.kicker} delay={i * 90} {...f} />
          ))}
        </div>
      </div>
    </section>
  )
}

function FeatureCard({
  icon,
  kicker,
  title,
  body,
  points,
  delay,
}: {
  icon: ReactNode
  kicker: string
  title: string
  body: string
  points: string[]
  delay: number
}) {
  const { ref, shown } = useReveal<HTMLDivElement>()
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`reveal ${shown ? 'in' : ''} group glass rounded-[20px] p-6 transition-transform duration-300 hover:-translate-y-1`}
    >
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-md shadow-brand-500/25">
        {icon}
      </div>
      <div className="mt-5 text-[12px] font-semibold uppercase tracking-[0.12em] text-brand-600">
        {kicker}
      </div>
      <h3 className="mt-1.5 text-[19px] font-semibold tracking-tight text-ink-900">{title}</h3>
      <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink-500">{body}</p>
      <ul className="mt-5 space-y-2 border-t border-black/[0.06] pt-4">
        {points.map((p) => (
          <li key={p} className="flex items-center gap-2.5 text-[13.5px] text-ink-700">
            <span className="grid h-4 w-4 place-items-center rounded-full bg-brand-500/12 text-brand-600">
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <path d="m20 6-11 11-5-5" />
              </svg>
            </span>
            {p}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SectionHeading({
  kicker,
  title,
  subtitle,
  center = true,
}: {
  kicker: string
  title: string
  subtitle?: string
  center?: boolean
}) {
  const { ref, shown } = useReveal<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={`reveal ${shown ? 'in' : ''} ${center ? 'mx-auto text-center' : ''} max-w-2xl`}
    >
      <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-brand-600">
        {kicker}
      </div>
      <h2 className="mt-3 text-balance text-[30px] font-bold leading-[1.12] tracking-[-0.025em] text-ink-900 sm:text-[40px]">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-balance text-[16px] leading-relaxed text-ink-500 sm:text-[17px]">
          {subtitle}
        </p>
      )}
    </div>
  )
}
