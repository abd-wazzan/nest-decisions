import {
  DecisionsModule,
  DecisionsService,
  from,
  Gate,
  InMemoryReviewQueue,
} from '@nest-decisions/core';
import { JevProvider } from '@nest-decisions/provider-jev';
import { Body, Controller, Get, Inject, Injectable, Module, Post } from '@nestjs/common';
import { DemoProvider } from './demo-provider';
import { InjectionCheck, RefundCheck, type RefundRequest } from './guards';
import { type Ticket, TicketTriage } from './ticket-triage';

const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
export const usingRealModel = Boolean(apiKey);
export const reviewQueue = new InMemoryReviewQueue();

@Injectable()
class Orders {
  // Stands in for your orders service. The status comes from your data, never from the caller.
  statusFor(_orderId: string): string {
    return 'delivered';
  }
}

@Controller()
class DemoController {
  constructor(
    @Inject(TicketTriage) private readonly triage: TicketTriage,
    @Inject(DecisionsService) private readonly service: DecisionsService,
  ) {}

  @Get()
  info() {
    return {
      provider: this.service.providerName,
      note: usingRealModel
        ? 'Using the real Jev model.'
        : 'No API key: using a keyword demo provider. It is not a model.',
      try: ['POST /triage', 'POST /chat', 'POST /refund', 'GET /reviews'],
    };
  }

  @Post('triage')
  async triageTicket(@Body() ticket: Ticket) {
    const { decision, result } = await this.triage.decide(ticket);
    return { decision, fromFallback: result.fromFallback };
  }

  // Blocks injection attempts, holds uncertain ones for review.
  @Gate({ decision: InjectionCheck, input: (c) => from.httpBody(c) })
  @Post('chat')
  chat(@Body() body: { message: string }) {
    return { reply: `You said: ${body.message}` };
  }

  // Approves clear refunds, holds uncertain or large ones, blocks clearly illegitimate ones.
  @Gate({
    decision: RefundCheck,
    input: (c): RefundRequest => {
      const b = from.httpBody<{ orderId: string; amount: number; reason: string }>(c);
      return { ...b, orderStatus: new Orders().statusFor(b.orderId) };
    },
  })
  @Post('refund')
  refund(@Body() body: { orderId: string; amount: number }) {
    return { refunded: body.orderId, amount: body.amount };
  }

  @Get('reviews')
  reviews() {
    return reviewQueue.items;
  }
}

@Module({
  imports: [
    DecisionsModule.forRoot({
      provider: apiKey ? new JevProvider({ backend: 'typesafe', apiKey }) : new DemoProvider(),
      reviewQueue,
      timeoutMs: 10_000,
    }),
  ],
  controllers: [DemoController],
  providers: [TicketTriage, InjectionCheck, RefundCheck],
})
export class AppModule {}
