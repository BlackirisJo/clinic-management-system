// Lightweight SVG logout/sign-out icon.
// Matches the existing sidebar and topbar button styling.
export default function LogoutIcon({ size = 19, color = 'currentColor' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Door frame */}
      <path
        d="M9 3 H17 C18.1046 3 19 3.89543 19 5 V19 C19 20.1046 18.1046 21 17 21 H9 C7.89543 21 7 20.1046 7 19 V5 C7 3.89543 7.89543 3 9 3 Z"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Door opening (gap in the frame) */}
      <path
        d="M12 12 H17 M14 9 L17 12 L14 15"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}