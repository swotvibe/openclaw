// Error handling and mapping for Notion API

export class NotionApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export function mapNotionError(error: unknown): NotionApiError {
  if (error instanceof NotionApiError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new NotionApiError(error.message);
  }
  
  return new NotionApiError(String(error));
}
