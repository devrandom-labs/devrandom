'use client';

import { useState, type ReactNode } from 'react';
import { Box, Button, ButtonBase, Checkbox, Chip, FormControlLabel, Stack, Typography } from '@mui/material';
import { futurePossibilities, harnessLayers } from './pitch-chapters.ts';
import { BrandMark, OrbitArtwork, PitchIcon } from './pitch-artwork.tsx';

const dark = '#20342a';
const lime = '#d7ef75';
const muted = '#b1bead';

function Caption({ children }: { readonly children: ReactNode }) {
  return <Typography variant="overline" sx={{ color: muted, display: 'block' }}>{children}</Typography>;
}

function StagePanel({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return <Box sx={{ bgcolor: dark, color: '#f5f7ed', borderRadius: '24px', minHeight: 445, p: { xs: 2.5, md: 3.5 }, position: 'relative', overflow: 'hidden', boxShadow: '0 20px 55px -30px #18332070', '& button': { color: 'inherit' } }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2.5 }}><Caption>{label}</Caption><Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: lime }} /></Stack>{children}
  </Box>;
}

function Choice({ children, selected, onClick, label }: { readonly children: ReactNode; readonly selected: boolean; readonly onClick: () => void; readonly label?: string }) {
  return <ButtonBase aria-pressed={selected} aria-label={label} onClick={onClick} sx={{ width: '100%', display: 'block', textAlign: 'left', border: '1px solid', borderColor: selected ? lime : '#52624f', bgcolor: selected ? '#d7ef7510' : 'transparent', borderRadius: 2, p: 1.6, transition: 'background 180ms, border-color 180ms', '&:hover': { bgcolor: '#ffffff09' } }}>{children}</ButtonBase>;
}

function Callout({ children, warning = false }: { readonly children: ReactNode; readonly warning?: boolean }) {
  return <Box role="status" sx={{ mt: 2, borderLeft: '2px solid', borderColor: warning ? '#f3a892' : lime, bgcolor: warning ? '#f3a8920a' : '#d7ef7509', py: 1.3, px: 1.7 }}><Typography variant="body2" sx={{ color: warning ? '#ffc7b7' : '#e5efc4' }}>{children}</Typography></Box>;
}

function IdeaStage() {
  return <StagePanel label="THE GOVERNED EVOLUTION LOOP"><OrbitArtwork /><Stack direction="row" sx={{ mt: -2, justifyContent: 'center', gap: 1, flexWrap: 'wrap' }}>{['Observe', 'Propose', 'Evaluate', 'Authorize'].map((label, index) => <Typography key={label} sx={{ fontSize: 10, color: muted, letterSpacing: '.06em' }}>{label}{index < 3 ? '  →' : ''}</Typography>)}</Stack></StagePanel>;
}

function IdentityStage() {
  const [promotion, setPromotion] = useState(false);
  return <StagePanel label="DISTINCT IDENTITIES · SCOPED DELEGATION">
    <Stack direction="row" sx={{ gap: 1, mb: 3 }}>{[{ role: 'You', id: 'User AID', icon: 'spark' }, { role: 'Personal agent', id: 'Agent AID', icon: 'network' }, { role: 'Governor', id: 'Governor AID', icon: 'shield' }].map((item) => <Box key={item.role} sx={{ flex: 1, border: '1px solid #50614d', borderRadius: 2, p: { xs: 1, md: 2 }, textAlign: 'center' }}><PitchIcon name={item.icon as 'spark' | 'network' | 'shield'} sx={{ color: lime, mb: 1, fontSize: 28 }} /><Typography sx={{ fontSize: 12, fontWeight: 600 }}>{item.role}</Typography><Typography sx={{ fontSize: 10, color: muted, mt: 0.4 }}>{item.id}</Typography></Box>)}</Stack>
    <Stack direction="row" gap={1} sx={{ mb: 2 }}><Button size="small" onClick={() => setPromotion(false)} aria-pressed={!promotion} sx={{ bgcolor: !promotion ? '#d7ef7520' : 'transparent', border: '1px solid #56654d' }}>Task Mandate</Button><Button size="small" onClick={() => setPromotion(true)} aria-pressed={promotion} sx={{ bgcolor: promotion ? '#d7ef7520' : 'transparent', border: '1px solid #56654d' }}>Promotion Mandate</Button></Stack>
    <Box key={String(promotion)} sx={{ animation: 'arrive 300ms ease both' }}>
      <Typography variant="h3" sx={{ fontSize: 23, mb: 1.5 }}>{promotion ? 'You → Governor' : 'You → Personal agent'}</Typography>
      <Typography variant="body2" sx={{ color: muted }}>{promotion ? 'May authorize eligible changes to this task’s harness, within the approved evolution scope, risk ceiling, and validity period.' : 'May read, edit, and test the scoped repository, within its budget and validity period. Cannot deploy, read production secrets, or expand its mandate.'}</Typography>
      <Stack direction="row" sx={{ gap: 0.7, flexWrap: 'wrap', mt: 2 }}>{(promotion ? ['Exact lineage', 'Protected metrics', 'Expiry & revocation'] : ['Exact task', 'Permitted tools', 'Budget & expiry']).map((text) => <Chip key={text} label={text} size="small" sx={{ color: '#dbe4ce', border: '1px solid #52634d' }} />)}</Stack>
    </Box>
    <Callout>{promotion ? 'Delegates promotion, never permission expansion.' : 'Task ownership, agent identity, and delegated authority stay distinct.'}</Callout>
  </StagePanel>;
}

function HarnessStage() {
  const [layer, setLayer] = useState(1);
  const selected = harnessLayers[layer] ?? harnessLayers[0];
  return <StagePanel label="H1 · INITIAL SPECIALIZATION">
    <Box sx={{ border: '1px dashed #7e8b65', borderRadius: 2, p: 1.5, mb: 2.5 }}><Caption>EXAMPLE TASK CONTRACT</Caption><Typography variant="body2">Repair receipt compatibility.<br/>Preserve tamper rejection. Do not deploy.</Typography></Box>
    <Stack gap={1}>{harnessLayers.map((item, index) => <Choice key={item.name} selected={layer === index} onClick={() => setLayer(index)} label={item.name}><Stack direction="row" alignItems="center" gap={2}><Typography sx={{ fontSize: 10, color: muted }}>{item.symbol}</Typography><Typography sx={{ fontSize: 14, flex: 1 }}>{item.name}</Typography><PitchIcon name={layer === index ? 'check' : 'arrow'} sx={{ fontSize: 18, color: lime }}/></Stack></Choice>)}</Stack>
    <Typography key={layer} variant="body2" sx={{ color: muted, mt: 2, minHeight: 65, animation: 'arrive 250ms ease both' }}>{selected.description}</Typography>
    <Box sx={{ borderTop: '1px solid #52634d', pt: 1.5 }}><Caption>ONE PI EXECUTOR · SPECIALISTS ONLY WHEN NEEDED</Caption></Box>
  </StagePanel>;
}

const memoryStops = [
  { title: 'Raw evidence', sub: 'Bounded local disk outbox', text: 'Preserve allowed observations, proposals, decisions, and effects. Secret bytes are withheld before they are stored.' },
  { title: 'Durable acceptance', sub: 'Devrandom Server → Atlas', text: 'Authenticated, ordered, idempotent batches receive a durable acknowledgement. Only the server holds Atlas credentials.' },
  { title: 'Relevant experience', sub: 'Atlas Vector Search', text: 'Retrieve analogous episodes to inform a hypothesis. Every summary can lead back to raw evidence; exact code uses deterministic lookup.' },
  { title: 'Focused context', sub: 'Local Context Index', text: 'The next model turn receives current verified state and relevant history. The complete transcript remains outside active context.' },
] as const;

function MemoryStage() {
  const [selected, setSelected] = useState(0);
  const stop = memoryStops[selected] ?? memoryStops[0];
  return <StagePanel label="FROM EXPERIENCE TO USEFUL CONTEXT"><Stack gap={1}>{memoryStops.map((item, index) => <Choice key={item.title} selected={selected === index} onClick={() => setSelected(index)} label={item.title}><Stack direction="row" alignItems="center" gap={2}><Box sx={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: selected === index ? lime : '#3b5140', color: selected === index ? dark : muted, fontSize: 12 }}>{index + 1}</Box><Box sx={{ flex: 1 }}><Typography variant="body2" fontWeight={600}>{item.title}</Typography><Typography sx={{ fontSize: 10, color: muted }}>{item.sub}</Typography></Box><PitchIcon name="arrow" sx={{ color: lime, fontSize: 18 }}/></Stack></Choice>)}</Stack><Callout>{stop.text}</Callout><Typography sx={{ color: muted, fontSize: 10, mt: 2 }}>Similarity retrieves experience. It never proves truth or grants permission.</Typography></StagePanel>;
}

function EvolutionStage() {
  const [candidate, setCandidate] = useState(1);
  const [noImprovement, setNoImprovement] = useState(false);
  const candidates = [
    { name: 'C1 · Instructions', change: '+ remind the executor to verify compatibility', risk: 'A reminder may not supply a recovery procedure.' },
    { name: 'C2 · Skill / workflow', change: '+ retrieve analogous failure episodes\n+ inspect exact code and history\n+ require compatibility verification', risk: 'A recovery skill may overfit or add unnecessary calls.' },
    { name: 'C3 · Context policy', change: '+ include compatibility history for versioned-format edits', risk: 'Extra context may distract or increase cost.' },
  ];
  const selected = candidates[candidate] ?? candidates[0];
  return <StagePanel label="CANDIDATE LAB · ILLUSTRATIVE, NOT MEASURED">
    <Caption>FALSIFIABLE HYPOTHESIS</Caption><Typography variant="body2" sx={{ mb: 2 }}>Could a compatibility-recovery procedure prevent a repeat failure?</Typography>
    <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} sx={{ mb: 2 }}>{candidates.map((item, index) => <Choice key={item.name} selected={candidate === index} onClick={() => setCandidate(index)} label={item.name}><Typography sx={{ fontSize: 11, whiteSpace: 'nowrap' }}>{item.name}</Typography></Choice>)}</Stack>
    <Box sx={{ bgcolor: '#13271f', borderRadius: 2, p: 2, minHeight: 130 }}><Typography sx={{ fontFamily: 'monospace', color: lime, whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.9 }}>{selected?.change}</Typography><Typography sx={{ fontSize: 11, color: muted, mt: 1 }}>{selected?.risk}</Typography></Box>
    <Stack direction="row" flexWrap="wrap" gap={0.8} sx={{ mt: 2 }}>{['Repeated trials', 'Locked holdout', 'Tamper audit', 'Matched budgets'].map((label) => <Chip key={label} label={label} size="small" sx={{ color: muted, border: '1px solid #54644e' }} />)}</Stack>
    <Button size="small" onClick={() => setNoImprovement(!noImprovement)} aria-pressed={noImprovement} sx={{ mt: 1.2, p: 0, textDecoration: 'underline', textUnderlineOffset: 4 }}>No eligible improvement</Button>
    <Callout>{noImprovement ? 'Keep H1. A new version is not automatically a better version.' : 'H1 stays active during evaluation. Any candidate must earn promotion; no winner is predetermined.'}</Callout>
  </StagePanel>;
}

const promotionGates = [
  { who: 'Protected local control plane', title: 'Evaluate & audit', body: 'Repeated comparable trials, a locked holdout, complete acknowledged evidence, exact artifacts, and non-compensatory safety floors.' },
  { who: 'Local Governor · distinct AID', title: 'Verify mandate & sign', body: 'Check current scope, expiry, revocation, risk, and the exact evaluation binding. Sign only a lawful, evidence-backed decision.' },
  { who: 'Devrandom Server', title: 'Verify & commit', body: 'Verify the signed decision and expected incumbent. Atomically commit one active-revision transition. Never choose or grade the winner.' },
  { who: 'Local Run Supervisor', title: 'Activate after receipt', body: 'Use the committed revision only after the durable receipt. Preserve the old revision and rejected branches for audit and rollback.' },
] as const;

function PromotionStage() {
  const [gate, setGate] = useState(0);
  const [expired, setExpired] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const selected = promotionGates[gate] ?? promotionGates[0];
  return <StagePanel label="PROMOTION REQUIRES EVERY GATE">
    <Stack direction="row" gap={1} sx={{ mb: 3 }}>{promotionGates.map((item, index) => <ButtonBase aria-label={item.title} key={item.title} onClick={() => setGate(index)} sx={{ height: 5, flex: 1, minHeight: 24, borderRadius: 4, '&::after': { content: '""', height: 5, width: '100%', borderRadius: 4, bgcolor: index <= gate ? lime : '#4a5c46' } }} />)}</Stack>
    <Stack direction="row" alignItems="center" justifyContent="space-between"><PitchIcon name="shield" sx={{ fontSize: 40, color: lime }} /><Typography sx={{ fontFamily: 'monospace', color: muted }}>{gate + 1} / 4</Typography></Stack>
    <Box key={gate} sx={{ animation: 'arrive 250ms ease both', mt: 2, minHeight: 152 }}><Caption>{selected.who}</Caption><Typography variant="h3" sx={{ mb: 1 }}>{selected.title}</Typography><Typography variant="body2" sx={{ color: muted }}>{selected.body}</Typography></Box>
    <Button onClick={() => setGate((gate + 1) % 4)} endIcon={<PitchIcon name="arrow" />} sx={{ px: 0, color: `${lime} !important` }}>Explain the next gate</Button>
    <Box sx={{ borderTop: '1px solid #52634d', mt: 1, pt: 1.5 }}><Caption>WHAT IF A REQUIREMENT FAILS?</Caption><Stack direction="row" flexWrap="wrap"><FormControlLabel control={<Checkbox checked={expired} onChange={(_, checked) => setExpired(checked)} sx={{ color: muted, '&.Mui-checked': { color: lime } }} />} label={<Typography sx={{ fontSize: 12 }}>Expired mandate</Typography>} /><FormControlLabel control={<Checkbox checked={incomplete} onChange={(_, checked) => setIncomplete(checked)} sx={{ color: muted, '&.Mui-checked': { color: lime } }} />} label={<Typography sx={{ fontSize: 12 }}>Missing evidence</Typography>} /></Stack></Box>
    <Callout warning={expired || incomplete}>{expired || incomplete ? `Promotion blocked. ${expired ? 'Passing evidence cannot replace a current mandate.' : 'A valid mandate cannot replace complete protected evidence.'} The incumbent remains active.` : 'All gates are required. This walkthrough explains the protocol; it does not authorize or activate a revision.'}</Callout>
  </StagePanel>;
}

const attacks = [
  { name: 'Deploy to production', boundary: 'Tool Gateway', explanation: 'Blocked before effect: deployment is outside the Task Mandate. Better performance cannot create a missing capability.' },
  { name: 'Replace the evaluator', boundary: 'Protected evaluator', explanation: 'Rejected: candidate-controlled behavior cannot replace the protected manifest, verifier, or held-out answers.' },
  { name: 'Erase failed evidence', boundary: 'Evidence integrity & tamper audit', explanation: 'Rejected: failed observations and candidates remain addressable. Deleting inconvenient results cannot improve eligibility.' },
  { name: 'Promote itself', boundary: 'Governor & activation commit', explanation: 'Rejected: proposal capability is not promotion authority. A candidate cannot create the Governor signature or bypass the durable commit.' },
] as const;

function BoundaryStage() {
  const [attempt, setAttempt] = useState<number | null>(null);
  const selected = attempt === null ? undefined : attacks[attempt];
  return <StagePanel label="CHOOSE AN ILLUSTRATIVE ATTACK"><Stack gap={1}>{attacks.map((item, index) => <Choice key={item.name} selected={attempt === index} onClick={() => setAttempt(index)} label={item.name}><Stack direction="row" alignItems="center" justifyContent="space-between"><Typography variant="body2">{item.name}</Typography><PitchIcon name="arrow" sx={{ color: '#f3ba9d', fontSize: 18 }} /></Stack></Choice>)}</Stack>
    <Box sx={{ mt: 2.5 }}><Caption>{selected?.boundary ?? 'THE TRUST BOUNDARY'}</Caption><Callout warning={selected !== undefined}>{selected?.explanation ?? 'Choose a scenario to see which independent boundary prevents it.'}</Callout></Box>
    <Stack direction="row" gap={2} sx={{ mt: 2 }}><Chip size="small" label="Authority unchanged" sx={{ color: lime, bgcolor: '#d7ef7510' }} /><Typography sx={{ fontSize: 10, color: muted, alignSelf: 'center' }}>Required outcome: retain incumbent + record attempt</Typography></Stack>
  </StagePanel>;
}

function ContinuityStage() {
  const [frame, setFrame] = useState(0);
  const [revoked, setRevoked] = useState(false);
  const title = frame === 0 ? 'Verified checkpoint → ready to resume' : frame === 1 ? 'Process stopped. The task still exists.' : revoked ? 'Recovery blocked. Authority was revoked.' : 'New incarnation. Same accountable Run.';
  return <StagePanel label="PROCESS LOSS · ILLUSTRATED">
    <Stack direction="row" alignItems="center" gap={2} sx={{ py: 2 }}><Box sx={{ width: 64, height: 64, border: '1px solid #69815c', borderRadius: 3, display: 'grid', placeItems: 'center', color: frame === 1 ? '#6f806a' : lime, opacity: frame === 1 ? 0.5 : 1, transition: 'opacity 400ms' }}><BrandMark size={38}/></Box><Box><Caption>LIVE PROCESS</Caption><Typography variant="h3" sx={{ fontSize: 21 }}>{frame === 1 ? 'Offline' : frame === 2 && revoked ? 'Not admitted' : frame === 2 ? 'Incarnation B' : 'Incarnation A'}</Typography></Box></Stack>
    <Box sx={{ bgcolor: '#13271f', borderRadius: 2, p: 2, my: 2 }}>{[['Task revision', 'Same immutable intent'], ['Run & agent', 'Same accountability'], ['Harness', 'Server-committed revision'], ['Checkpoint', 'Verified artifacts & next step']].map(([label, value]) => <Stack key={label} direction="row" justifyContent="space-between" gap={1} sx={{ py: 0.6 }}><Typography sx={{ fontSize: 11, color: muted }}>{label}</Typography><Typography sx={{ fontSize: 11 }}>{value}</Typography></Stack>)}</Box>
    <Stack direction="row" gap={1} flexWrap="wrap"><Button variant="outlined" onClick={() => setFrame(frame === 1 ? 2 : 1)} sx={{ borderColor: '#718661' }}>{frame === 1 ? 'Illustrate recovery' : 'Illustrate process loss'}</Button>{frame > 0 && <Button onClick={() => { setFrame(0); setRevoked(false); }}>Reset</Button>}</Stack>
    <FormControlLabel control={<Checkbox checked={revoked} onChange={(_, checked) => setRevoked(checked)} sx={{ color: muted, '&.Mui-checked': { color: lime } }} />} label={<Typography sx={{ fontSize: 12 }}>Revoke mandate before recovery</Typography>} />
    <Callout warning={frame === 2 && revoked}>{title}</Callout><Typography sx={{ fontSize: 10, color: muted, mt: 1.5 }}>Recheck authority. Reconcile committed state. Rebuild bounded context.</Typography>
  </StagePanel>;
}

function SharingStage() {
  const [sanitized, setSanitized] = useState(false);
  return <StagePanel label="SANITIZED PACKAGE · SEPARATE FROM PRIVATE H2">
    <Stack direction="row" alignItems="center" gap={2} sx={{ mb: 2 }}><PitchIcon name="branch" sx={{ color: lime, fontSize: 40 }}/><Box><Typography variant="h3">A portable method</Typography><Typography sx={{ color: muted, fontSize: 12 }}>Derive → sanitize → verify → publish → fork</Typography></Box></Stack>
    <Stack gap={1}>{[{ name: 'Skills & workflow', keep: true }, { name: 'Safe provenance & compatibility', keep: true }, { name: 'Credentials, keys & mandates', keep: false }, { name: 'Private traces & task memory', keep: false }].map((item) => <Stack key={item.name} direction="row" justifyContent="space-between" alignItems="center" sx={{ border: '1px solid #50614d', borderRadius: 2, p: 1.7, opacity: sanitized && !item.keep ? 0.55 : 1, transition: 'opacity 500ms', gap: 1 }}><Typography sx={{ fontSize: 12, textDecoration: sanitized && !item.keep ? 'line-through' : 'none' }}>{item.name}</Typography><Typography sx={{ fontSize: 10, color: item.keep ? lime : '#f3ba9d' }}>{sanitized ? item.keep ? 'RETAIN' : 'REMOVE' : item.keep ? 'BEHAVIOR' : 'PRIVATE'}</Typography></Stack>)}</Stack>
    <Button onClick={() => setSanitized(!sanitized)} endIcon={<PitchIcon name="arrow" />} sx={{ mt: 2, color: `${lime} !important`, px: 0 }}>{sanitized ? 'Show private revision' : 'Show sanitization'}</Button>
    <Callout>{sanitized ? 'Behavior travels. Authority stays home.' : 'Derive a separate package. The original private revision stays intact.'}</Callout><Typography sx={{ fontSize: 10, color: muted, mt: 1.5 }}>Portability checks + SAID + publisher signature. A fork imports no authority.</Typography>
  </StagePanel>;
}

function FutureStage() {
  const [index, setIndex] = useState(0);
  const selected = futurePossibilities[index] ?? futurePossibilities[0];
  return <StagePanel label="FUTURE POSSIBILITIES · NOT SHIPPED CAPABILITIES"><Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 3 }}>{futurePossibilities.map((item, i) => <Choice key={item.name} selected={index === i} onClick={() => setIndex(i)} label={item.name}><PitchIcon name={item.icon} sx={{ color: lime, mb: 1 }} /><Typography sx={{ fontSize: 12 }}>{item.name}</Typography></Choice>)}</Box><Box key={index} sx={{ animation: 'arrive 300ms ease both', minHeight: 160 }}><Caption>{selected.foundation}</Caption><Typography variant="h3" sx={{ fontSize: 25, my: 1 }}>{selected.title}</Typography><Typography variant="body2" sx={{ color: muted }}>{selected.description}</Typography></Box><Callout>{selected.boundary}</Callout></StagePanel>;
}

export function PitchStage({ chapter }: { readonly chapter: number }) {
  const stages = [IdeaStage, IdentityStage, HarnessStage, MemoryStage, EvolutionStage, PromotionStage, BoundaryStage, ContinuityStage, SharingStage, FutureStage];
  const Stage = stages[chapter] ?? IdeaStage;
  return <Stage />;
}
