import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const UploadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 16V4m0 0-4 4m4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></Icon>
);
export const CheckIcon = (p: IconProps) => (<Icon {...p}><path d="m5 12.500 4.500 4.500L19 7.500" /></Icon>);
export const AlertIcon = (p: IconProps) => (<Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.500v5M12 16h.01" /></Icon>);
export const InfoIcon = (p: IconProps) => (<Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>);
export const CloseIcon = (p: IconProps) => (<Icon {...p}><path d="m6 6 12 12M18 6 6 18" /></Icon>);
export const MenuIcon = (p: IconProps) => (<Icon {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>);
export const FilmIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 5v14M16 5v14M3 10h5M16 10h5M3 14h5M16 14h5" /></Icon>
);
export const UnderstandIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const DetectIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="11" cy="11" r="6.500" /><path d="m20 20-4.200-4.200M11 8.500v5M8.500 11h5" /></Icon>
);
export const ControlIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Icon>
);
