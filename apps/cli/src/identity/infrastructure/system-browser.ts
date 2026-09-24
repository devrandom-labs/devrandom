import { spawn } from 'node:child_process';

export interface BrowserInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export function browserInvocation(
  platform: NodeJS.Platform,
  registrationUrl: string,
): BrowserInvocation {
  switch (platform) {
    case 'darwin':
      return { executable: 'open', arguments: [registrationUrl] };
    case 'win32':
      return {
        executable: 'rundll32.exe',
        arguments: ['url.dll,FileProtocolHandler', registrationUrl],
      };
    case 'aix':
    case 'android':
    case 'freebsd':
    case 'haiku':
    case 'linux':
    case 'openbsd':
    case 'sunos':
    case 'cygwin':
    case 'netbsd':
      return { executable: 'xdg-open', arguments: [registrationUrl] };
  }
}

export async function openSystemBrowser(registrationUrl: string): Promise<void> {
  const invocation = browserInvocation(process.platform, registrationUrl);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
