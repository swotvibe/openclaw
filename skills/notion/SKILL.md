---
name: notion
description: Notion API for creating and managing pages, databases, and blocks.
homepage: https://developers.notion.com
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "env": ["NOTION_TOKEN"] }, "primaryEnv": "NOTION_TOKEN" },
  }
---

# notion

Use the Notion API to create/read/update pages, database containers, data sources, and blocks.

## Setup

1. Create an integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`)
3. Export it for OpenClaw:

```bash
export NOTION_TOKEN="ntn_your_key_here"
```

4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)

## OpenClaw Plugin Tools

The OpenClaw Notion plugin provides 20 tools for working with Notion. Use these tools instead of direct API calls.

### Tool List

**Search & Fetch:**
- `notion_search` - Search pages and data sources
- `notion_fetch` - Fetch a page or data source by ID
- `notion_query_data_source` - Query a data source with filters and sorting

**Page Operations:**
- `notion_create_page` - Create a page in a data source
- `notion_update_page` - Update page properties or content
- `notion_delete_page` - Move page to trash

**Data Source Operations:**
- `notion_create_data_source` - Create a data source in a database container
- `notion_update_data_source` - Update data source properties

**Block Operations:**
- `notion_get_block` - Get a block by ID
- `notion_get_block_children` - Get block children with pagination
- `notion_append_block_children` - Add blocks to a page/block
- `notion_update_block` - Update block content
- `notion_delete_block` - Delete/archive a block

**Database Operations:**
- `notion_get_database` - Get database container metadata

**User Operations:**
- `notion_get_user` - Get user by ID
- `notion_list_users` - List all workspace users

**Comment Operations:**
- `notion_get_comments` - Get comments for a block/page
- `notion_create_comment` - Create a comment
- `notion_update_comment` - Update a comment

**Advanced Search:**
- `notion_advanced_search` - Advanced search with filters, sorting, pagination

### Tool Usage Examples

**Create a database container with initial data source:**

```
notion_create_data_source(
  parentId: "page_id_here",
  title: "My Database",
  properties: {
    "Name": { title: {} },
    "Status": { select: { options: [{ name: "Todo" }, { name: "Done" }] } }
  }
)
```

**Create a row in a data source:**

```
notion_create_page(
  parentId: "data_source_id_here",
  properties: {
    "Name": { title: [{ text: { content: "New Item" } }] },
    "Status": { select: { name: "Todo" } }
  }
)
```

**Query a data source:**

```
notion_query_data_source(
  dataSourceId: "data_source_id_here",
  filter: { property: "Status", select: { equals: "Active" } },
  sorts: [{ property: "Date", direction: "descending" }]
)
```

**Add blocks to a page:**

```
notion_append_block_children(
  blockId: "page_id_here",
  children: [
    { type: "paragraph", paragraph: { rich_text: [{ text: { content: "Hello" } }] } }
  ],
  position: { before: "block_id" }  // Optional
)
```

**Delete a page or data source:**

```
notion_delete_page(pageId: "page_id_here")
notion_update_data_source(dataSourceId: "data_source_id_here", inTrash: true)
```

### Important Notes

- **Parent types:** Use `type: "page"` for page parents and `type: "data_source"` for data source parents
- **Data source ID:** When creating rows, use the `data_source_id` (not the `database_id`)
- **Finding data source ID:** Use `notion_fetch` on the database container to get its `data_sources` array
- **Deletion:** Use `in_trash: true` (2026-03-11 API). The old `archived: true` returns 404.
- **Position parameter:** `notion_append_block_children` supports optional `position` parameter

## Property Types

Common property formats for database items:

- **Title:** `{"title": [{"text": {"content": "..."}}]}`
- **Rich text:** `{"rich_text": [{"text": {"content": "..."}}]}`
- **Select:** `{"select": {"name": "Option"}}`
- **Multi-select:** `{"multi_select": [{"name": "A"}, {"name": "B"}]}`
- **Date:** `{"date": {"start": "2024-01-15", "end": "2024-01-16"}}`
- **Checkbox:** `{"checkbox": true}`
- **Number:** `{"number": 42}`
- **URL:** `{"url": "https://..."}`
- **Email:** `{"email": "a@b.com"}`
- **Relation:** `{"relation": [{"id": "page_id"}]}`

## API Version Notes

This plugin uses Notion API `2026-03-11`:

- **Database model:** Databases split into containers + child data sources (2025-09-03)
- **Page creation:** Use `parent.data_source_id` when creating rows
- **Deletion:** Use `in_trash: true` instead of `archived: true`
- **Block append:** Use `position` instead of `after`
- **Meeting notes:** Use `meeting_notes` blocks instead of `transcription`

## SDK Integration

The OpenClaw Notion plugin uses the official `@notionhq/client` SDK (`v5.19.0`) internally:

- **Authentication:** Bearer token via `NOTION_TOKEN` env var
- **API versioning:** `Notion-Version: 2026-03-11` header automatically applied
- **Retry logic:** Built-in retries for `429 rate_limited` and server errors (5xx)
- **Error handling:** SDK-native error types mapped to `NotionApiError`

## Limits & Notes

- Page/database IDs are UUIDs (with or without dashes)
- Rate limit: ~3 requests/second average; SDK auto-retries on `429`
- Append block children: up to 100 children per request, 2 levels of nesting
- Payload size limits: up to 1000 block elements and 500KB overall
- Database view filters cannot be set via API (UI-only)
