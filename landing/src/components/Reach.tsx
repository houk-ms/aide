import { SectionHeading } from './Features'
import { useReveal } from '../useReveal'
import { Logo } from './Logo'

const points = [
  {
    title: 'Runs on its own',
    body: 'Morning briefings, periodic scans, end-of-day reconciliation — Aide works on a schedule, not only when you ask.',
  },
  {
    title: 'Reaches you anywhere',
    body: 'Your briefing and daily report arrive in the app or on your phone — WeChat, Telegram, Discord, or WhatsApp. Pick where each job lands.',
  },
  {
    title: 'Takes commands remotely',
    body: 'Reply from your phone to snooze a task, ask a question, or approve an action — no need to open the app.',
  },
]

export function Reach() {
  const { ref, shown } = useReveal<HTMLDivElement>()

  return (
    <section id="reach" className="relative px-4 py-28 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          kicker="Always on"
          title="It doesn't wait for you to sit down"
          subtitle="The same Aide — running in the background and finding you wherever you are, so work keeps moving after you've stepped away from the desk."
        />

        <div
          ref={ref}
          className={`reveal ${shown ? 'in' : ''} mt-12 grid items-center gap-12 md:grid-cols-2`}
        >
          {/* Phone messenger delivery mock — lead with the visual */}
          <div className="order-1">
            <MessengerPane />
          </div>

          {/* Narrative — accent-bordered, distinct from the checklist sections */}
          <div className="order-2">
            <ul className="space-y-5">
              {points.map((p) => (
                <li
                  key={p.title}
                  className="rounded-r-xl border-l-2 border-brand-400/60 bg-gradient-to-r from-brand-500/[0.06] to-transparent py-2 pl-5 pr-3"
                >
                  <h3 className="text-[16px] font-semibold tracking-tight text-ink-900">{p.title}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-ink-500">{p.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

function MessengerPane() {
  return (
    <div className="glass-panel relative mx-auto max-w-sm overflow-hidden rounded-[24px] p-1">
      <div className="rounded-[20px] bg-[#ededed] p-3.5">
        {/* header */}
        <div className="mb-3 flex items-center justify-center">
          <span className="text-[12.5px] font-medium text-[oklch(40%_0.01_270)]">Aide</span>
        </div>

        <div className="space-y-3">
          {/* incoming: morning briefing */}
          <div className="flex gap-2">
            <div className="grid h-7 w-7 shrink-0 place-items-center self-start rounded-md bg-gradient-to-br from-brand-400 to-brand-600 shadow-sm">
              <Logo size={14} />
            </div>
            <div className="min-w-0 rounded-xl rounded-tl-sm bg-white px-3 py-2.5 text-[12px] leading-[1.6] text-[oklch(25%_0.01_270)] shadow-sm">
              <p className="font-semibold text-[oklch(18%_0.01_270)]">Good morning — 3 things need you today</p>
              <ul className="mt-1.5 space-y-1 text-[oklch(40%_0.01_270)]">
                <li>· Reply to Q3 budget thread (due today)</li>
                <li>· Review PR #482 — auth refactor</li>
                <li>· 1:1 with Priya at 2:00 PM</li>
              </ul>
            </div>
          </div>

          {/* outgoing: remote command */}
          <div className="flex flex-row-reverse">
            <div className="max-w-[78%] rounded-xl rounded-tr-sm bg-[#95ec69] px-3 py-2 text-[12px] leading-[1.5] text-[oklch(22%_0.02_150)] shadow-sm">
              Snooze the budget thread to Friday
            </div>
          </div>

          {/* incoming: confirmation */}
          <div className="flex gap-2">
            <div className="grid h-7 w-7 shrink-0 place-items-center self-start rounded-md bg-gradient-to-br from-brand-400 to-brand-600 shadow-sm">
              <Logo size={14} />
            </div>
            <div className="rounded-xl rounded-tl-sm bg-white px-3 py-2 text-[12px] leading-[1.5] text-[oklch(40%_0.01_270)] shadow-sm">
              Done — snoozed to Friday 9:00 AM. Two left for today.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
