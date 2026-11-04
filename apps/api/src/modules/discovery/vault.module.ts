import { Global, Module } from '@nestjs/common';
import { Vault } from './vault';

/** One vault for credentials and webhook secrets; the master key is read once at boot. */
@Global()
@Module({ providers: [{ provide: Vault, useFactory: () => new Vault(process.env) }], exports: [Vault] })
export class VaultModule {}
