import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

@Controller('webhooks/notifications')
export class NotificationWebhookController {
  @Post('bounce')
  @HttpCode(200)
  handleBounce(
    @Body() _body: unknown,
    @Headers() _headers: Record<string, string>,
  ) {
    // Handle provider bounce/complaint webhooks
    // Update delivery status in database
    return Promise.resolve({ received: true });
  }

  @Post('delivery')
  @HttpCode(200)
  handleDelivery(
    @Body() _body: unknown,
    @Headers() _headers: Record<string, string>,
  ) {
    // Handle delivery status updates
    return Promise.resolve({ received: true });
  }

  @Post('complaint')
  @HttpCode(200)
  handleComplaint(
    @Body() _body: unknown,
    @Headers() _headers: Record<string, string>,
  ) {
    // Handle complaint webhooks
    return Promise.resolve({ received: true });
  }
}
