// Credential resolution for Notion API token

export function resolveNotionToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error('NOTION_TOKEN environment variable is required for Notion API access');
  }
  return token;
}
