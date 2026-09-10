import { ChevronDown } from 'lucide-react'
import { inputBase } from './ModalRoot'

/** Shared dark-styled <select> with a chevron affordance, for modal forms. */
export function Select({
  value,
  onChange,
  children,
  id,
  mono,
  disabled,
  className = 'mt-1.5'
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  id?: string
  mono?: boolean
  disabled?: boolean
  /** Wrapper classes; defaults to the standard field gap. */
  className?: string
}): React.JSX.Element {
  return (
    <div className={`relative ${className}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputBase} ${mono ? 'font-mono' : ''} cursor-pointer appearance-none pr-8 [&_option]:bg-elev [&_option]:text-text disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        strokeWidth={1.5}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
      />
    </div>
  )
}
