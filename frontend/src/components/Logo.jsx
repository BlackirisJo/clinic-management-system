import { useEffect, useRef, useState } from 'react'

// Realistic medical stethoscope with subtle animated ECG line behind it.
// The ECG line animates briefly on user interaction, then returns to idle.
export default function Logo({ size = 52, small = false }) {
  const pathRef = useRef(null)
  const [pulseKey, setPulseKey] = useState(0)

  useEffect(() => {
    const el = pathRef.current
    if (!el) return

    let rafId = null

    const triggerPulse = () => {
      setPulseKey((k) => k + 1)
    }

    const onInteraction = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        triggerPulse()
      })
    }

    el.addEventListener('click', onInteraction)
    el.addEventListener('keydown', onInteraction)
    el.addEventListener('focus', onInteraction)

    return () => {
      el.removeEventListener('click', onInteraction)
      el.removeEventListener('keydown', onInteraction)
      el.removeEventListener('focus', onInteraction)
      cancelAnimationFrame(rafId)
    }
  }, [])

  const s = small ? 24 : 32
  const strokeW = small ? 1.8 : 2.2

  return (
    <div
      className={`brand-mark${small ? ' small' : ''}`}
      role="img"
      aria-label="نبض"
      tabIndex={0}
      style={{ cursor: 'pointer', outline: 'none' }}
    >
      <svg
        width={s}
        height={s}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="tubeGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#89CFF0" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#89CFF0" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {/* ECG pulse line — subtle, thin, baby blue, behind stethoscope */}
        <path
          ref={pathRef}
          key={pulseKey}
          d="M3 16 L7 16 L9 12 L11 20 L13 14 L15 18 L17 10 L19 22 L21 14 L23 16 L29 16"
          stroke="#89CFF0"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.55"
          style={{
            animation: 'ecgPulse 1.4s ease-out',
            transformOrigin: 'center',
          }}
        />

        {/* Stethoscope — ear pieces (binaurals) */}
        <ellipse cx="20" cy="6" rx="3.2" ry="2" fill="#89CFF0" opacity="0.85" />
        <ellipse cx="12" cy="6" rx="3.2" ry="2" fill="#89CFF0" opacity="0.85" />

        {/* Stethoscope — head tubes from earpieces down to chestpiece */}
        <path
          d="M20 8 C20 12, 18 15, 16 18"
          stroke="#89CFF0"
          strokeWidth={strokeW}
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
        <path
          d="M12 8 C12 12, 14 15, 16 18"
          stroke="#89CFF0"
          strokeWidth={strokeW}
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />

        {/* Stethoscope — Y-junction connector */}
        <circle cx="16" cy="18" r="1.6" fill="#89CFF0" opacity="0.85" />

        {/* Stethoscope — single tube down to chestpiece */}
        <path
          d="M16 19.6 C16 22, 13 24, 11 25.5"
          stroke="#89CFF0"
          strokeWidth={strokeW}
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />

        {/* Stethoscope — chestpiece (diaphragm) outer ring */}
        <circle cx="11" cy="26" r="4.5" stroke="#89CFF0" strokeWidth={strokeW} fill="none" opacity="0.85" />

        {/* Stethoscope — chestpiece inner disc */}
        <circle cx="11" cy="26" r="2.8" fill="#89CFF0" opacity="0.35" />
        <circle cx="11" cy="26" r="1.2" fill="#89CFF0" opacity="0.6" />

        <style>{`
          @keyframes ecgPulse {
            0% {
              stroke-dasharray: 220;
              stroke-dashoffset: 0;
              opacity: 0;
            }
            12% {
              opacity: 0.55;
              stroke-dasharray: 220;
              stroke-dashoffset: 0;
            }
            88% {
              opacity: 0.55;
              stroke-dasharray: 220;
              stroke-dashoffset: -220;
            }
            100% {
              stroke-dasharray: 220;
              stroke-dashoffset: -220;
              opacity: 0;
            }
          }
        `}</style>
      </svg>
    </div>
  )
}