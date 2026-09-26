import { Box, SvgIcon, Typography, type SvgIconProps } from '@mui/material';

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  play: 'm9 5 11 7-11 7Z',
  pause: 'M9 5v14M16 5v14',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6',
  branch: 'M6 5v14m0-7h7a5 5 0 0 0 5-5V5M3 3h6v4H3Zm12 0h6v4h-6ZM3 17h6v4H3Z',
  network: 'M12 7v5M5 17v-5h14v5M9 3h6v4H9ZM2 17h6v4H2Zm7 0h6v4H9Zm7 0h6v4h-6Z',
  clock: 'M12 8v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  expand: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6',
  close: 'm6 6 12 12M6 18 18 6',
  spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z',
  book: 'M12 5v16M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z',
  check: 'm5 12 4 4L19 6',
} as const;

export type PitchIconName = keyof typeof paths;

export function PitchIcon({ name, ...props }: SvgIconProps & { readonly name: PitchIconName }) {
  return <SvgIcon {...props} viewBox="0 0 24 24"><path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></SvgIcon>;
}

export function BrandMark({ size = 32 }: { readonly size?: number }) {
  return <Box component="svg" aria-hidden="true" viewBox="0 0 40 40" sx={{ width: size, height: size, flexShrink: 0 }}>
    <path d="M5 8h7v24H5zm11 7h7v17h-7zm11-7h7v24h-7z" fill="currentColor" />
    <path d="M16 8h7v4h-7z" fill="currentColor" />
  </Box>;
}

export function OrbitArtwork() {
  return <Box sx={{ position: 'relative', width: '100%', height: { xs: 340, md: 450 }, overflow: 'hidden' }}>
    <Box component="svg" aria-hidden="true" viewBox="0 0 560 460" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <defs><radialGradient id="harness-glow"><stop stopColor="#c5e97b" stopOpacity="0.16"/><stop offset="1" stopColor="#c5e97b" stopOpacity="0"/></radialGradient></defs>
      <circle cx="280" cy="228" r="215" fill="url(#harness-glow)" />
      <g fill="none" stroke="#a7bb8b" strokeOpacity="0.2"><ellipse cx="280" cy="228" rx="218" ry="144" transform="rotate(-28 280 228)"/><ellipse cx="280" cy="228" rx="218" ry="144" transform="rotate(28 280 228)"/><circle cx="280" cy="228" r="128"/><circle cx="280" cy="228" r="192" strokeDasharray="2 8" /></g>
      <Box component="g" sx={{ transformOrigin: '280px 228px', animation: 'orbit 45s linear infinite' }}><circle cx="280" cy="36" r="5" fill="#d7ef75"/><circle cx="280" cy="420" r="3" fill="#8ba98a"/></Box>
      <Box component="g" sx={{ animation: 'breathe 6s ease-in-out infinite', transformOrigin: '280px 228px' }}>
        <path d="m280 130 83 48v99l-83 48-83-48v-99Z" fill="#273e2e" stroke="#afc576" strokeWidth="1.2"/>
        <path d="m280 130 83 48-83 49-83-49Zm0 97v98" fill="#334a33" stroke="#afc576" strokeWidth="1.2"/>
        <path d="m280 155 60 34-60 35-60-35Z" fill="#d7ef75"/>
        <path d="m237 234 11 7v34l-11-7Zm21 12 11 7v34l-11-7Zm32 6 11-7v35l-11 7Zm21-12 11-7v35l-11 7Z" fill="#d7ef75"/>
      </Box>
    </Box>
    {[{ title: 'EVIDENCE', text: 'Learn from what happened', top: '9%', left: '5%' }, { title: 'BEHAVIOR', text: 'Evolve how it works', top: '70%', left: '5%' }, { title: 'AUTHORITY', text: 'Keep the ceiling fixed', top: '42%', left: '60%' }].map((item) => <Box key={item.title} sx={{ position: 'absolute', top: item.top, left: item.left, bgcolor: '#1e3026ee', border: '1px solid #4a6047', borderRadius: 2, px: 1.7, py: 1.1, maxWidth: '39%', backdropFilter: 'blur(8px)' }}><Typography sx={{ color: '#d7ef75', fontSize: 9, letterSpacing: '0.16em', fontWeight: 600 }}>{item.title}</Typography><Typography sx={{ color: '#e2e9d8', fontSize: { xs: 10, md: 12 }, mt: 0.4 }}>{item.text}</Typography></Box>)}
  </Box>;
}
