import { Injectable } from '@nestjs/common';

export interface NotificationTemplate {
  id: string;
  channel: string;
  subject?: string;
  body: string;
  variables: string[];
}

@Injectable()
export class NotificationTemplateService {
  private templates: Map<string, NotificationTemplate> = new Map();

  register(template: NotificationTemplate): void {
    this.templates.set(`${template.channel}:${template.id}`, template);
  }

  render(
    channel: string,
    templateId: string,
    variables: Record<string, string>,
  ): { subject?: string; body: string } | null {
    const template = this.templates.get(`${channel}:${templateId}`);
    if (!template) {
      return null;
    }

    let body = template.body;
    let subject = template.subject;

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      body = body.replace(new RegExp(placeholder, 'g'), value);
      if (subject) {
        subject = subject.replace(new RegExp(placeholder, 'g'), value);
      }
    }

    return { subject, body };
  }
}
