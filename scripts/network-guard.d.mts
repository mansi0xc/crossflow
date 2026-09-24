export function validateWriteDestination(rpcUrl: string, expectedGenesis: string, mode: 'devnet' | 'local'): string;
export function withVerifiedWriteDestination<T>(options: {
  rpcUrl: string;
  expectedGenesis: string;
  mode: 'devnet' | 'local';
  getGenesis: () => Promise<string>;
}, action: (context: { rpcUrl: string; genesis: string; mode: 'devnet' | 'local' }) => T): Promise<T>;
