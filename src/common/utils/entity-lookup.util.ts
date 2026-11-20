import { NotFoundException } from "@nestjs/common";

interface FindByIdReadableModel {
    findById(id: string): {
        lean(): {
            exec(): Promise<unknown>;
        };
    };
}

export async function findByIdOrThrow(
    model: FindByIdReadableModel,
    id: string,
    notFoundMessage: string
): Promise<Record<string, unknown>> {
    const doc = await model.findById(id).lean().exec();
    if (!doc) {
        throw new NotFoundException(notFoundMessage);
    }
    return doc as Record<string, unknown>;
}
