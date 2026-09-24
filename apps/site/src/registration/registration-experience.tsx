'use client';

import { contactEmailPattern } from '@devrandom/protocol';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { type ReactNode, type SyntheticEvent, useEffect, useMemo, useState } from 'react';

import {
  useApproveRegistrationMutation,
  useGetRegistrationApprovalQuery,
  useRejectRegistrationMutation,
  type GetRegistrationApprovalApiResponse,
} from '../api/issuer-endpoints.ts';
import { parseRegistrationFragment, type RegistrationBrowserLink } from './registration-link.ts';

type RegistrationEntry = { readonly kind: 'reading-registration-link' } | RegistrationBrowserLink;

const inactiveRequest = {
  registrationId: '0'.repeat(32),
  'x-devrandom-registration-capability': `browser_${'0'.repeat(43)}`,
};

function replaceWithSuccess(): void {
  window.location.replace('/registration/success/');
}

function continueIfIssued(projection: GetRegistrationApprovalApiResponse): void {
  if (projection.kind === 'issued') {
    replaceWithSuccess();
  }
}

export function RegistrationExperience() {
  const [entry, setEntry] = useState<RegistrationEntry>({
    kind: 'reading-registration-link',
  });
  const [contactEmail, setContactEmail] = useState('');
  const [mutationFailure, setMutationFailure] = useState<string>();

  useEffect(() => {
    const parsed = parseRegistrationFragment(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setEntry(parsed);
  }, []);

  const activeRequest =
    entry.kind === 'registration-link'
      ? {
          registrationId: entry.registrationId,
          'x-devrandom-registration-capability': entry.capability,
        }
      : inactiveRequest;
  const projection = useGetRegistrationApprovalQuery(activeRequest, {
    pollingInterval: 1_000,
    skip: entry.kind !== 'registration-link',
    skipPollingIfUnfocused: true,
  });
  const [approve, approval] = useApproveRegistrationMutation();
  const [reject, rejection] = useRejectRegistrationMutation();
  const validEmail = useMemo(
    () =>
      contactEmail.length >= 3 &&
      contactEmail.length <= 254 &&
      new RegExp(contactEmailPattern, 'u').test(contactEmail),
    [contactEmail],
  );

  useEffect(() => {
    if (projection.data !== undefined) {
      continueIfIssued(projection.data);
    }
  }, [projection.data]);

  if (entry.kind === 'reading-registration-link') {
    return <RegistrationShell title="Opening registration…" />;
  }
  if (entry.kind === 'invalid-registration-link') {
    return (
      <RegistrationShell title="Registration link unavailable">
        <Alert severity="error">
          This registration link is missing, malformed, or uses the wrong capability.
        </Alert>
      </RegistrationShell>
    );
  }
  if (projection.isError) {
    return (
      <RegistrationShell title="Registration unavailable">
        <Alert severity="error">
          The Registration Session could not be retrieved. Return to the terminal for its current
          disposition.
        </Alert>
      </RegistrationShell>
    );
  }
  if (projection.data === undefined) {
    return <RegistrationShell title="Loading registration…" />;
  }

  const current = projection.data;
  const actionPending = approval.isLoading || rejection.isLoading;
  const actionAllowed = current.kind === 'pending-proof' || current.kind === 'pending-approval';

  async function submitApproval(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> {
    event.preventDefault();
    if (!validEmail || entry.kind !== 'registration-link') {
      return;
    }
    setMutationFailure(undefined);
    try {
      const next = await approve({
        registrationId: entry.registrationId,
        'content-type': 'application/json',
        'x-devrandom-registration-capability': entry.capability,
        body: { contactEmail },
      }).unwrap();
      continueIfIssued(next);
    } catch {
      setMutationFailure('Approval was not accepted. Return to the terminal for details.');
    }
  }

  async function submitRejection(): Promise<void> {
    if (entry.kind !== 'registration-link') {
      return;
    }
    setMutationFailure(undefined);
    try {
      await reject({
        registrationId: entry.registrationId,
        'content-type': 'application/json',
        'x-devrandom-registration-capability': entry.capability,
        body: { action: 'reject' },
      }).unwrap();
    } catch {
      setMutationFailure('Rejection was not accepted. Return to the terminal for details.');
    }
  }

  return (
    <RegistrationShell title="Approve Devrandom registration">
      <Stack spacing={3}>
        <Alert severity="info">
          Contact email is self-asserted and unverified. It is not placed in your credential and
          does not prove mailbox ownership.
        </Alert>
        <Stack spacing={1}>
          <Typography variant="subtitle2" color="text.secondary">
            Expected issuer
          </Typography>
          <Typography>{current.issuerAid}</Typography>
          <Typography variant="subtitle2" color="text.secondary">
            User AID
          </Typography>
          <Typography sx={{ overflowWrap: 'anywhere' }}>{current.userAid}</Typography>
          <Typography color="text.secondary">{current.abbreviatedUserAid}</Typography>
          <Chip label={`Comparison code ${current.comparisonCode}`} variant="outlined" />
        </Stack>
        <Stack spacing={1}>
          <Typography variant="h5">{current.credentialName}</Typography>
          <List dense disablePadding>
            {current.capabilities.map((capability) => (
              <ListItem disableGutters key={capability}>
                <ListItemText primary={capability} />
              </ListItem>
            ))}
          </List>
          <Typography color="text.secondary">Expires {current.expiresAt}</Typography>
        </Stack>
        {current.kind === 'pending-proof' ? (
          <Alert severity="warning">
            The terminal proof is still pending. Approval can be recorded now, but issuance cannot
            begin until proof completes.
          </Alert>
        ) : null}
        {current.kind === 'rejected' || current.kind === 'expired' ? (
          <Alert severity="error">This Registration Session is {current.kind}.</Alert>
        ) : null}
        {current.kind === 'approved' || current.kind === 'issuing' ? (
          <Alert severity="info">Credential issuance is in progress.</Alert>
        ) : null}
        {mutationFailure === undefined ? null : <Alert severity="error">{mutationFailure}</Alert>}
        <Stack component="form" spacing={2} onSubmit={(event) => void submitApproval(event)}>
          <TextField
            required
            disabled={!actionAllowed || actionPending}
            label="Contact email (self-asserted)"
            type="email"
            value={contactEmail}
            onChange={(event) => {
              setContactEmail(event.target.value);
            }}
            slotProps={{ htmlInput: { maxLength: 254, pattern: contactEmailPattern } }}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button
              disabled={!actionAllowed || actionPending || !validEmail}
              type="submit"
              variant="contained"
            >
              Approve registration
            </Button>
            <Button
              color="error"
              disabled={!actionAllowed || actionPending}
              onClick={() => void submitRejection()}
              variant="outlined"
            >
              Reject
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </RegistrationShell>
  );
}

interface RegistrationShellProps {
  readonly title: string;
  readonly children?: ReactNode;
}

function RegistrationShell({ title, children }: RegistrationShellProps) {
  return (
    <Box component="main" sx={{ alignItems: 'center', display: 'grid', minHeight: '100vh', py: 8 }}>
      <Container maxWidth="sm">
        <Stack spacing={4}>
          <Stack spacing={1.5}>
            <Typography variant="overline" color="primary.main" sx={{ fontWeight: 700 }}>
              Devrandom Labs
            </Typography>
            <Typography variant="h1">{title}</Typography>
            <Typography color="text.secondary">
              Your signing keys remain in the local CLI and never enter this browser.
            </Typography>
          </Stack>
          <Paper variant="outlined">
            <Stack spacing={2.5} sx={{ p: 3 }}>
              {children}
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </Box>
  );
}
