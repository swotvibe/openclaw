// Notion API Client
// Implements HTTP requests to Notion API endpoints using official SDK

import { Client, isNotionClientError, APIResponseError } from "@notionhq/client";

const NOTION_API_VERSION = "2026-03-11";

interface NotionApiClientConfig {
  baseUrl: string;
  token: string;
}

export interface NotionApiSuccess<T> {
  ok: true;
  data: T;
}

export interface NotionApiError {
  ok: false;
  error: string;
}

export type NotionApiResponse<T> = NotionApiSuccess<T> | NotionApiError;

type NotionSearchKind = "page" | "data_source" | "all";
type NotionFetchTargetType = "auto" | "page" | "data_source";
type NotionPageParentInput = { type: "page" | "data_source"; id: string };
type NotionCommentParentType = "page_id" | "block_id";
type NotionPageWithOptionalChildren = Record<string, unknown> & {
  appended_children?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNotionId(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  const directId = extractNotionIdCandidate(trimmed);
  if (directId) {
    return directId;
  }

  try {
    const url = new URL(trimmed);
    return extractNotionIdCandidate(url.pathname);
  } catch {
    return null;
  }
}

function extractNotionIdCandidate(value: string): string | null {
  const matches = value.match(
    /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  );
  const candidate = matches?.at(-1);
  if (!candidate) {
    return null;
  }

  const compact = candidate.replace(/-/g, "");
  if (compact.length !== 32) {
    return null;
  }

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

function mapCreatePageParent(parent: NotionPageParentInput): Record<string, string> {
  return parent.type === "page" ? { page_id: parent.id } : { data_source_id: parent.id };
}

function buildDataSourcePropertiesPatch(
  addProperties?: unknown,
  renameProperties?: unknown[],
): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};

  if (isRecord(addProperties)) {
    Object.assign(properties, addProperties);
  }

  if (Array.isArray(renameProperties)) {
    for (const renameProperty of renameProperties) {
      if (!isRecord(renameProperty)) {
        continue;
      }
      const from = typeof renameProperty.from === "string" ? renameProperty.from : undefined;
      const to = typeof renameProperty.to === "string" ? renameProperty.to : undefined;
      if (!from || !to) {
        continue;
      }

      const existing = properties[from];
      properties[from] = isRecord(existing) ? { ...existing, name: to } : { name: to };
    }
  }

  return Object.keys(properties).length > 0 ? properties : undefined;
}

function mapNotionError(error: unknown): NotionApiError {
  if (isNotionClientError(error)) {
    const apiError = error as APIResponseError;
    return {
      ok: false as const,
      error: `Notion API error: ${apiError.message} (code: ${apiError.code}, status: ${apiError.status})`,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false as const,
      error: error.message,
    };
  }

  return {
    ok: false as const,
    error: String(error),
  };
}

export class NotionApiClient {
  private config: NotionApiClientConfig;
  private notionClient: Client;

  constructor(config: NotionApiClientConfig) {
    this.config = config;
    // Initialize official SDK with all relevant runtime config
    // SDK handles retries for 429 rate limits and server errors by default
    this.notionClient = new Client({
      auth: config.token,
      notionVersion: NOTION_API_VERSION, // Explicitly set to 2026-03-11 (SDK default is 2025-09-03)
    });
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<NotionApiResponse<T>> {
    const url = `${this.config.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: Object.assign(
          {
            Authorization: `Bearer ${this.config.token}`,
            "Notion-Version": NOTION_API_VERSION,
            "Content-Type": "application/json",
          },
          options.headers || {},
        ),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false as const,
          error: `Notion API error: ${response.status} ${response.statusText} - ${errorText}`,
        };
      }

      const data = await response.json();
      return {
        ok: true as const,
        data,
      };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async getBlock(blockId: string) {
    try {
      const block = await this.notionClient.blocks.retrieve({ block_id: blockId });
      return { ok: true as const, data: block };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async getBlockChildren(blockId: string, pageSize?: number, startCursor?: string) {
    try {
      const children = await this.notionClient.blocks.children.list({
        block_id: blockId,
        page_size: pageSize,
        start_cursor: startCursor,
      });
      return { ok: true as const, data: children };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async appendBlockChildren(blockId: string, children: unknown[]) {
    try {
      const result = await this.notionClient.blocks.children.append({
        block_id: blockId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: children as any,
      });
      return { ok: true as const, data: result };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async updateBlock(blockId: string, block: unknown) {
    try {
      const updated = await this.notionClient.blocks.update({
        block_id: blockId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(block as any),
      });
      return { ok: true as const, data: updated };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async deleteBlock(blockId: string) {
    try {
      const deleted = await this.notionClient.blocks.delete({ block_id: blockId });
      return { ok: true as const, data: deleted };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async getDatabase(databaseId: string) {
    try {
      const database = await this.notionClient.databases.retrieve({ database_id: databaseId });
      return { ok: true as const, data: database };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async getDataSource(dataSourceId: string) {
    // SDK doesn't have dataSources methods yet, fall back to manual request
    return this.request(`/data_sources/${dataSourceId}`);
  }

  async deletePage(pageId: string) {
    try {
      const deleted = await this.notionClient.pages.update({
        page_id: pageId,
        archived: true,
      });
      return { ok: true as const, data: deleted };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async search(query?: string, kind?: NotionSearchKind, pageSize?: number, cursor?: string) {
    try {
      const filter =
        kind && kind !== "all"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ property: "object", value: kind } as any)
          : undefined;

      const results = await this.notionClient.search({
        query: query || "",
        filter,
        page_size: pageSize,
        start_cursor: cursor,
      });
      return { ok: true as const, data: results };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async fetchPage(
    target: string,
    targetType: NotionFetchTargetType = "auto",
    includeBlocks?: boolean,
    blockPageSize?: number,
    blockCursor?: string,
  ) {
    const normalizedId = normalizeNotionId(target);
    if (!normalizedId) {
      return {
        ok: false as const,
        error: `Invalid Notion page or data source target: ${target}`,
      };
    }

    if (targetType === "data_source") {
      return this.fetchDataSourceTarget(target, normalizedId);
    }

    if (targetType === "page") {
      return this.fetchPageById(normalizedId, includeBlocks, blockPageSize, blockCursor);
    }

    const page = await this.fetchPageById(normalizedId, includeBlocks, blockPageSize, blockCursor);
    if (page.ok) {
      return page;
    }

    const dataSource = await this.fetchDataSourceTarget(target, normalizedId);
    if (dataSource.ok) {
      return dataSource;
    }

    return {
      ok: false as const,
      error: `${page.error}; ${dataSource.error}`,
    };
  }

  private async fetchPageById(
    pageId: string,
    includeBlocks?: boolean,
    blockPageSize?: number,
    blockCursor?: string,
  ) {
    try {
      const page = await this.notionClient.pages.retrieve({ page_id: pageId });
      if (!includeBlocks) {
        return { ok: true as const, data: page };
      }

      const children = await this.getBlockChildren(pageId, blockPageSize, blockCursor);
      if (!children.ok) {
        return children;
      }
      return {
        ok: true as const,
        data: Object.assign({}, page as Record<string, unknown>, {
          children: children.data,
        }),
      };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  private async fetchDataSourceTarget(target: string, normalizedId: string) {
    const direct = await this.getDataSource(normalizedId);
    if (direct.ok) {
      return direct;
    }

    const database = await this.getDatabase(normalizedId);
    if (!database.ok) {
      return direct;
    }

    const dataSources = Array.isArray(
      (database.data as unknown as Record<string, unknown>)?.data_sources,
    )
      ? ((database.data as unknown as Record<string, unknown>).data_sources as unknown[])
      : [];
    const ids = dataSources
      .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined))
      .filter((value): value is string => typeof value === "string");

    if (ids.length === 1) {
      return this.getDataSource(ids[0]);
    }

    return {
      ok: false as const,
      error:
        ids.length === 0
          ? `Could not resolve a data source from target: ${target}`
          : `Notion URL resolves to a database with multiple data sources. Pass a data source ID instead: ${target}`,
    };
  }

  async queryDataSource(
    dataSourceId: string,
    filter?: unknown,
    sorts?: unknown[],
    pageSize?: number,
    cursor?: string,
  ) {
    // SDK doesn't have dataSources.query yet, fall back to manual request
    const body: Record<string, unknown> = {};
    if (filter) {
      body.filter = filter;
    }
    if (sorts) {
      body.sorts = sorts;
    }
    if (pageSize) {
      body.page_size = pageSize;
    }
    if (cursor) {
      body.start_cursor = cursor;
    }

    return this.request(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async createPage(
    parent: NotionPageParentInput,
    properties: unknown,
    content?: unknown[],
    icon?: unknown,
    cover?: unknown,
  ) {
    try {
      const page = await this.notionClient.pages.create({
        parent: mapCreatePageParent(parent),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: properties as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: content as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        icon: icon as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cover: cover as any,
      });
      return { ok: true as const, data: page };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async updatePage(
    pageId: string,
    properties?: unknown,
    appendContent?: unknown[],
    icon?: unknown,
    cover?: unknown,
    eraseContent?: boolean,
    archive?: boolean,
    restore?: boolean,
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateData: any = {};
      if (properties) {
        updateData.properties = properties;
      }
      if (icon) {
        updateData.icon = icon;
      }
      if (cover) {
        updateData.cover = cover;
      }
      if (eraseContent) {
        updateData.erase_content = true;
      }
      if (archive) {
        updateData.archived = true;
      }
      if (restore) {
        updateData.archived = false;
      }

      const pageResult = await this.notionClient.pages.update({
        page_id: pageId,
        ...updateData,
      });

      if (!appendContent) {
        return { ok: true as const, data: pageResult };
      }

      // Append blocks via separate endpoint
      const appendResult = await this.appendBlockChildren(pageId, appendContent);
      if (!appendResult.ok) {
        return appendResult;
      }

      return {
        ok: true as const,
        data: Object.assign({}, pageResult as Record<string, unknown>, {
          appended_children: appendResult.data,
        }) as NotionPageWithOptionalChildren,
      };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async createDataSource(
    parentDatabaseId: string,
    title: string,
    properties?: unknown,
    icon?: unknown,
  ) {
    const body: Record<string, unknown> = {
      parent: { database_id: parentDatabaseId },
      title: [{ text: { content: title } }],
      properties:
        isRecord(properties) && Object.keys(properties).length > 0
          ? properties
          : { Name: { title: {} } },
    };
    if (icon) {
      body.icon = icon;
    }

    return this.request("/data_sources", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateDataSource(
    dataSourceId: string,
    title?: string,
    addProperties?: unknown,
    renameProperties?: unknown[],
    parentDatabaseId?: string,
    inTrash?: boolean,
    icon?: unknown,
  ) {
    const body: Record<string, unknown> = {};
    if (title) {
      body.title = [{ text: { content: title } }];
    }
    const properties = buildDataSourcePropertiesPatch(addProperties, renameProperties);
    if (properties) {
      body.properties = properties;
    }
    if (parentDatabaseId) {
      body.parent = { database_id: parentDatabaseId };
    }
    if (inTrash !== undefined) {
      body.in_trash = inTrash;
    }
    if (icon) {
      body.icon = icon;
    }

    return this.request(`/data_sources/${dataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  // Phase 3: User operations
  async getUser(userId: string) {
    try {
      const user = await this.notionClient.users.retrieve({ user_id: userId });
      return { ok: true as const, data: user };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async listUsers() {
    try {
      const users = await this.notionClient.users.list();
      return { ok: true as const, data: users };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  // Phase 4: Comment operations
  async getComments(blockId: string, pageSize?: number, startCursor?: string) {
    try {
      const comments = await this.notionClient.comments.list({
        block_id: blockId,
        page_size: pageSize,
        start_cursor: startCursor,
      });
      return { ok: true as const, data: comments };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async createComment(params: {
    richText: unknown[];
    targetId?: string;
    parentType?: NotionCommentParentType;
    discussionId?: string;
  }) {
    try {
      if (params.discussionId) {
        const comment = await this.notionClient.comments.create({
          discussion_id: params.discussionId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rich_text: params.richText as any,
        });
        return { ok: true as const, data: comment };
      } else if (params.targetId && params.parentType) {
        const comment = await this.notionClient.comments.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parent: { [params.parentType]: params.targetId } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rich_text: params.richText as any,
        });
        return { ok: true as const, data: comment };
      } else {
        return {
          ok: false as const,
          error: "Creating a comment requires either discussionId or both targetId and parentType.",
        };
      }
    } catch (error) {
      return mapNotionError(error);
    }
  }

  async updateComment(commentId: string, richText: unknown[]) {
    try {
      const comment = await this.notionClient.comments.update({
        comment_id: commentId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rich_text: richText as any,
      });
      return { ok: true as const, data: comment };
    } catch (error) {
      return mapNotionError(error);
    }
  }

  // Phase 5: Advanced search
  async advancedSearch(
    query: string,
    filter?: unknown,
    sort?: unknown,
    pageSize?: number,
    startCursor?: string,
  ) {
    try {
      const results = await this.notionClient.search({
        query,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filter: filter as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sort: sort as any,
        page_size: pageSize,
        start_cursor: startCursor,
      });
      return { ok: true as const, data: results };
    } catch (error) {
      return mapNotionError(error);
    }
  }
}
