import { PipeTransform, Injectable, BadRequestException, ArgumentMetadata } from '@nestjs/common';
import { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}
  transform(value: unknown, metadata?: ArgumentMetadata) {
    // These schemas describe the request BODY. A method-level @UsePipes runs this pipe on
    // EVERY argument (path params, query, custom decorators too), so a string `:floorId`
    // param was being validated against the body schema → "Expected object, received string".
    // Only validate the body; let params/query/custom args pass through untouched.
    if (metadata && metadata.type !== 'body') return value;
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: r.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
      });
    }
    return r.data;
  }
}
