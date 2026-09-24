import { Alert, Box, Container, Paper, Stack, Typography } from '@mui/material';

export function RegistrationSuccess() {
  return (
    <Box component="main" sx={{ alignItems: 'center', display: 'grid', minHeight: '100vh', py: 8 }}>
      <Container maxWidth="sm">
        <Paper variant="outlined">
          <Stack spacing={2.5} sx={{ p: 4 }}>
            <Typography variant="overline" color="primary.main" sx={{ fontWeight: 700 }}>
              Devrandom Labs
            </Typography>
            <Typography variant="h2">Credential issued</Typography>
            <Alert severity="success">Your Devrandom User credential was issued.</Alert>
            <Typography color="text.secondary">
              You can close this page and return to your terminal. The CLI still needs to receive
              and verify the credential before admission is complete.
            </Typography>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
