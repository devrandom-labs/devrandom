'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { chapters } from './pitch-chapters.ts';
import { BrandMark, PitchIcon } from './pitch-artwork.tsx';
import { PitchStage } from './pitch-stage.tsx';

export function PitchExperience() {
  const [chapter, setChapter] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [still, setStill] = useState(false);
  const [dialog, setDialog] = useState<'notes' | 'detail' | null>(null);
  const [fullscreenNotice, setFullscreenNotice] = useState('');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const current = chapters[chapter] ?? chapters[0];

  const goTo = useCallback((index: number) => {
    setChapter(Math.max(0, Math.min(chapters.length - 1, index)));
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!playing || dialog !== null) return;
    const timer = window.setTimeout(() => {
      if (chapter === chapters.length - 1) setPlaying(false);
      else setChapter(chapter + 1);
    }, 14_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [playing, chapter, dialog]);

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      const element = event.target;
      if (
        dialog !== null ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (element instanceof HTMLElement &&
          (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable))
      )
        return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(chapter + 1);
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(chapter - 1);
      }
      if (event.key === 'Home') {
        event.preventDefault();
        goTo(0);
      }
      if (event.key === 'End') {
        event.preventDefault();
        goTo(chapters.length - 1);
      }
    };
    window.addEventListener('keydown', navigate);
    return () => {
      window.removeEventListener('keydown', navigate);
    };
  }, [chapter, dialog, goTo]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      setFullscreenNotice('');
    } catch {
      setFullscreenNotice(
        'Fullscreen is unavailable here. The pitch still works in this browser window.',
      );
    }
  }

  return (
    <Box
      data-motion={still || reducedMotion ? 'still' : 'animated'}
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        backgroundImage: 'radial-gradient(ellipse at 90% 60%, #e5ead760, transparent 65%)',
      }}
    >
      <Box
        component="a"
        href="#pitch-main"
        sx={{
          position: 'absolute',
          left: 16,
          top: -100,
          zIndex: 100,
          bgcolor: 'secondary.main',
          p: 2,
          borderRadius: 2,
          '&:focus': { top: 12 },
        }}
      >
        Skip to pitch
      </Box>
      <Box
        component="header"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          mx: { xs: 2.5, md: 5, xl: 7 },
          py: { xs: 2, md: 2.8 },
        }}
      >
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
        >
          <ButtonBase
            onClick={() => {
              goTo(0);
            }}
            aria-label="Devrandom home"
            sx={{ gap: 1.1, borderRadius: 1 }}
          >
            <BrandMark />
            <Typography sx={{ fontWeight: 700, fontSize: 22, letterSpacing: '-0.07em' }}>
              devrandom
            </Typography>
          </ButtonBase>
          <Stack
            component="nav"
            aria-label="Pitch sections"
            direction="row"
            sx={{ gap: 3.5, display: { xs: 'none', lg: 'flex' } }}
          >
            {[
              { label: 'The idea', page: 0 },
              { label: 'Inside the system', page: 2 },
              { label: 'Beyond the demo', page: 9 },
            ].map((item) => (
              <ButtonBase
                key={item.label}
                onClick={() => {
                  goTo(item.page);
                }}
                sx={{
                  fontSize: 12,
                  color: 'text.secondary',
                  '&:hover': { color: 'text.primary' },
                  py: 1,
                }}
              >
                {item.label}
              </ButtonBase>
            ))}
          </Stack>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
            <Chip
              label="THE INTERACTIVE PITCH"
              variant="outlined"
              sx={{
                mr: 1.5,
                display: { xs: 'none', sm: 'flex' },
                letterSpacing: '.08em',
                fontSize: 9,
                borderColor: '#bec7b1',
              }}
            />
            <Tooltip title="Presenter notes">
              <IconButton
                aria-label="Presenter notes"
                onClick={() => {
                  setPlaying(false);
                  setDialog('notes');
                }}
              >
                <PitchIcon name="book" fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={still || reducedMotion ? 'Motion paused' : 'Pause animations'}>
              <IconButton
                aria-label="Toggle animations"
                aria-pressed={still || reducedMotion}
                onClick={() => {
                  setStill(!still);
                }}
                disabled={reducedMotion}
              >
                <PitchIcon name={still || reducedMotion ? 'play' : 'pause'} fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Toggle fullscreen">
              <IconButton
                aria-label="Toggle fullscreen"
                onClick={() => {
                  void toggleFullscreen();
                }}
                sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
              >
                <PitchIcon name="expand" fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '155px minmax(0, 1fr)' },
          gap: { xs: 2, lg: 5, xl: 7 },
          px: { xs: 2.5, md: 5, xl: 7 },
          pt: { xs: 2.5, md: 4.5 },
          pb: 3,
          width: '100%',
          maxWidth: 1800,
          mx: 'auto',
          flex: 1,
        }}
      >
        <Box
          component="aside"
          sx={{
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <Box>
            <Typography
              variant="overline"
              sx={{ color: 'text.secondary', display: { xs: 'none', lg: 'block' }, mb: 2 }}
            >
              EXPLORE THE STORY
            </Typography>
            <Stack
              component="nav"
              aria-label="Chapters"
              direction={{ xs: 'row', lg: 'column' }}
              sx={{
                gap: { xs: 0.6, lg: 0.5 },
                overflowX: { xs: 'auto', lg: 'visible' },
                pb: { xs: 1.5, lg: 0 },
              }}
            >
              {chapters.map((item, index) => (
                <ButtonBase
                  key={item.label}
                  aria-label={`${String(index + 1).padStart(2, '0')} ${item.label}`}
                  aria-current={index === chapter ? 'step' : undefined}
                  onClick={() => {
                    goTo(index);
                  }}
                  sx={{
                    borderRadius: 2,
                    px: 1.2,
                    py: 1.2,
                    minHeight: 42,
                    justifyContent: 'flex-start',
                    gap: 1.5,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    bgcolor: chapter === index ? '#e4eacb' : 'transparent',
                    color: chapter === index ? 'text.primary' : 'text.secondary',
                    transition: 'background 200ms',
                    '&:hover': { bgcolor: '#e9ecdf' },
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: 10,
                      fontFamily: 'monospace',
                      color: index === chapter ? '#415a2b' : '#8b9384',
                    }}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </Typography>
                  <Typography sx={{ fontSize: 12, fontWeight: index === chapter ? 600 : 400 }}>
                    {item.label}
                  </Typography>
                </ButtonBase>
              ))}
            </Stack>
          </Box>
          <Box sx={{ display: { xs: 'none', lg: 'block' }, mt: 4, pl: 1 }}>
            <Box sx={{ height: 34, width: '1px', bgcolor: '#bac4a9', mb: 2 }} />
            <Typography
              sx={{ fontSize: 10, color: 'text.secondary', maxWidth: 120, lineHeight: 1.8 }}
            >
              A system that earns
              <br />
              its next revision.
            </Typography>
            <Typography sx={{ color: '#859078', fontFamily: 'monospace', fontSize: 10, mt: 2 }}>
              ← → to explore
            </Typography>
          </Box>
        </Box>

        <Box component="main" id="pitch-main" tabIndex={-1} sx={{ minWidth: 0, outline: 'none' }}>
          <Stack
            direction="row"
            sx={{ justifyContent: 'space-between', alignItems: 'center', mb: { xs: 2, md: 3.5 } }}
          >
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
              <Box sx={{ width: 6, height: 6, bgcolor: '#7d9448', borderRadius: '50%' }} />
              <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
                Interactive pitch · illustrative scenarios
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'text.secondary' }}>
              {String(chapter + 1).padStart(2, '0')} / 10
            </Typography>
          </Stack>

          <Box
            key={chapter}
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                md: 'minmax(0, .94fr) minmax(0, 1.06fr)',
              },
              gap: { xs: 3, md: 4.5 },
              alignItems: 'center',
              animation: 'arrive 450ms ease both',
              minHeight: { lg: 535 },
            }}
          >
            <Box sx={{ py: { xs: 1, md: 2 } }}>
              <Typography variant="overline" sx={{ display: 'block', color: '#718246', mb: 2 }}>
                {current.eyebrow}
              </Typography>
              <Typography
                component="h1"
                variant={chapter === 0 ? 'h1' : 'h2'}
                sx={{ maxWidth: 620, mb: 2.5 }}
              >
                {chapter === 0 ? (
                  <>
                    Better agents.
                    <br />
                    <Box component="span" sx={{ color: '#6f803e' }}>
                      Bounded
                      <br />
                      authority.
                    </Box>
                  </>
                ) : (
                  current.title
                )}
              </Typography>
              <Typography
                sx={{
                  color: 'text.secondary',
                  fontSize: { xs: 15, md: 16 },
                  maxWidth: 420,
                  mb: 3,
                  lineHeight: 1.75,
                }}
              >
                {current.description}
              </Typography>
              {chapter === 0 ? (
                <Button
                  variant="contained"
                  onClick={() => {
                    goTo(1);
                  }}
                  endIcon={<PitchIcon name="arrow" />}
                  sx={{ px: 3, py: 1.5 }}
                >
                  Start the story
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setPlaying(false);
                    setDialog('detail');
                  }}
                  endIcon={<PitchIcon name="arrow" sx={{ fontSize: 18 }} />}
                  sx={{
                    p: 0,
                    minHeight: 40,
                    textDecoration: 'underline',
                    textUnderlineOffset: 5,
                    fontSize: 12,
                  }}
                >
                  A closer look
                </Button>
              )}
              <Stack direction="row" sx={{ gap: 0.8, flexWrap: 'wrap', mt: 3.5 }}>
                {(chapter === 0
                  ? ['Self-improving', 'Evidence-driven', 'Independently governed']
                  : chapter === 9
                    ? ['Future possibilities', 'Not core dependencies']
                    : ['Intended system behavior', 'Explore the diagram →']
                ).map((label) => (
                  <Typography
                    key={label}
                    sx={{
                      fontSize: 9,
                      color: 'text.secondary',
                      border: '1px solid #d2d9c5',
                      borderRadius: 5,
                      py: 0.5,
                      px: 1.1,
                    }}
                  >
                    {label}
                  </Typography>
                ))}
              </Stack>
            </Box>
            <Box
              onPointerDown={() => {
                setPlaying(false);
              }}
            >
              <PitchStage chapter={chapter} />
            </Box>
          </Box>

          <Box
            sx={{
              mt: { xs: 3.5, md: 4 },
              pt: 2.5,
              borderTop: '1px solid',
              borderColor: 'divider',
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '105px 1fr' },
              gap: { xs: 1, sm: 2 },
            }}
          >
            <Typography variant="overline" sx={{ color: 'text.secondary' }}>
              WHY IT MATTERS
            </Typography>
            <Typography
              sx={{
                fontSize: { xs: 16, md: 19 },
                fontWeight: 500,
                letterSpacing: '-0.035em',
                lineHeight: 1.5,
              }}
            >
              {current.takeaway}
            </Typography>
          </Box>
          {chapter === 0 && (
            <Box sx={{ mt: 2.5, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>
              {[
                { title: 'Adaptable', text: 'Change the harness, not the goal.' },
                { title: 'Accountable', text: 'Know who proposed and authorized.' },
                { title: 'Persistent', text: 'Keep progress beyond the process.' },
              ].map((item) => (
                <Box key={item.title}>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, mb: 0.5 }}>
                    {item.title}
                  </Typography>
                  <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.6 }}>
                    {item.text}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>

      <Box component="footer" sx={{ mx: { xs: 2.5, md: 5, xl: 7 }, pb: 2.5, pt: 1 }}>
        <LinearProgress
          aria-label="Pitch progress"
          variant="determinate"
          value={((chapter + 1) / chapters.length) * 100}
          sx={{
            height: 2,
            mb: 2,
            bgcolor: '#dce1d1',
            '& .MuiLinearProgress-bar': { bgcolor: '#607b38' },
          }}
        />
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 1 }}
        >
          <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
            <Button
              onClick={() => {
                if (chapter === chapters.length - 1) setChapter(0);
                setPlaying(!playing);
              }}
              startIcon={<PitchIcon name={playing ? 'pause' : 'play'} sx={{ fontSize: 16 }} />}
              sx={{ px: 1, fontSize: 11 }}
            >
              {playing ? 'Pause story' : 'Autoplay'}
            </Button>
            <Typography
              sx={{ display: { xs: 'none', sm: 'block' }, fontSize: 10, color: 'text.secondary' }}
            >
              {playing
                ? 'Advances every 14 seconds · interact to pause'
                : 'Explore at your own pace. Every boundary has a reason.'}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
            <Button
              disabled={chapter === 0}
              aria-label="Previous chapter"
              onClick={() => {
                goTo(chapter - 1);
              }}
              sx={{ minWidth: 44, px: 1 }}
            >
              <PitchIcon name="arrow" sx={{ transform: 'rotate(180deg)', fontSize: 18 }} />
            </Button>
            <Button
              onClick={() => {
                goTo(chapter === chapters.length - 1 ? 0 : chapter + 1);
              }}
              variant="outlined"
              endIcon={<PitchIcon name="arrow" sx={{ fontSize: 16 }} />}
              sx={{ fontSize: 11, borderColor: '#c1cbb4' }}
            >
              {chapter === chapters.length - 1 ? 'Restart pitch' : 'Next chapter'}
            </Button>
          </Stack>
        </Stack>
        {fullscreenNotice && (
          <Typography role="status" sx={{ fontSize: 12, mt: 1 }}>
            {fullscreenNotice}
          </Typography>
        )}
      </Box>

      <Dialog
        open={dialog !== null}
        onClose={() => {
          setDialog(null);
        }}
        aria-labelledby="pitch-dialog-title"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="pitch-dialog-title" sx={{ pr: 7 }}>
          {dialog === 'notes' ? 'Presenter notes' : 'A closer look'}
          <IconButton
            aria-label="Close details"
            onClick={() => {
              setDialog(null);
            }}
            sx={{ position: 'absolute', top: 12, right: 12 }}
          >
            <PitchIcon name="close" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Typography variant="overline" color="text.secondary">
            {current.eyebrow}
          </Typography>
          <Typography variant="h3" sx={{ my: 2 }}>
            {current.title}
          </Typography>
          <Typography sx={{ mb: 3 }}>
            {dialog === 'notes' ? current.note : current.detail}
          </Typography>
          <Box sx={{ p: 2, bgcolor: '#f0f3e5', borderRadius: 2 }}>
            <Typography variant="body2">
              Standalone pitch. No runtime connection, live measurements, or authority is created by
              this exhibit.
            </Typography>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
