// Error handling and mapping for Notion API

import { isNotionClientError, APIResponseError } from "@notionhq/client";

export class NotionApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export function mapNotionError(error: unknown): NotionApiError {
  if (isNotionClientError(error)) {
    const apiError = error as APIResponseError;
    return new NotionApiError(apiError.message, apiError.code, apiError.status);
  }

  if (error instanceof NotionApiError) {
    return error;
  }

  if (error instanceof Error) {
    return new NotionApiError(error.message);
  }

  return new NotionApiError(String(error));
}
