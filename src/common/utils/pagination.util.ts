export interface NormalizedPagination {
    readonly page: number;
    readonly limit: number;
    readonly skip: number;
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

export function normalizePagination(
    rawPage?: number,
    rawLimit?: number,
    defaultLimit = 20,
    maxLimit = 100
): NormalizedPagination {
    const page = Math.max(1, rawPage ? Math.floor(Number(rawPage)) : 1);
    const limit = Math.min(
        maxLimit,
        Math.max(1, rawLimit ? Math.floor(Number(rawLimit)) : defaultLimit)
    );
    return {
        page,
        limit,
        skip: (page - 1) * limit,
    };
}

export function buildPaginatedResponse<
    T,
    TExtra extends Record<string, unknown> = Record<string, never>,
>(
    items: T[],
    total: number,
    page: number,
    limit: number,
    extra?: TExtra
): PaginatedResult<T> & TExtra {
    const safeTotal = Math.max(0, Number(total || 0));
    const totalPages = Math.max(1, Math.ceil(safeTotal / limit));
    return {
        items,
        total: safeTotal,
        page,
        limit,
        totalPages,
        ...(extra ?? ({} as TExtra)),
    };
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
