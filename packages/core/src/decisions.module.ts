import { Module } from '@nestjs/common';
import { DecisionsService } from './decisions.service.js';
import { ConfigurableModuleClass } from './options.js';

/**
 * DecisionsModule.forRoot({ provider }) or .forRootAsync({ useFactory, inject }).
 * Global by default; pass `isGlobal: false` to scope it.
 */
@Module({ providers: [DecisionsService], exports: [DecisionsService] })
export class DecisionsModule extends ConfigurableModuleClass {}
