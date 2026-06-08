/**
 * Regression test for the ZodValidationPipe bug that 400'd every editor write
 * (PATCH /floors/:floorId/placements, POST /floors/:floorId/rooms, PATCH /rooms/:id):
 * the body schema was applied to the string `:floorId` path param
 * ("Expected object, received string"). Runs under ts-jest — no dev stack needed.
 */
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../src/common/zod.pipe';

const bodySchema = z.object({
  upserts: z.array(z.object({ deviceCode: z.string() })).default([]),
  deletes: z.array(z.string()).default([]),
});

describe('ZodValidationPipe — only validates the request body', () => {
  const pipe = new ZodValidationPipe(bodySchema);

  it('passes a string :floorId path param through untouched (the bug)', () => {
    const id = '6a25b2562b66f619ceb73787';
    expect(pipe.transform(id, { type: 'param', metatype: String, data: 'floorId' } as any)).toBe(id);
  });

  it('passes query + custom args through untouched', () => {
    expect(pipe.transform('1', { type: 'query' } as any)).toBe('1');
    const user = { id: 'u1' };
    expect(pipe.transform(user, { type: 'custom' } as any)).toBe(user);
  });

  it('still validates and parses a valid body', () => {
    const parsed = pipe.transform({ upserts: [{ deviceCode: 'WIFI_AP' }], deletes: [] }, { type: 'body' } as any);
    expect(parsed).toMatchObject({ upserts: [{ deviceCode: 'WIFI_AP' }] });
  });

  it('still rejects an invalid body', () => {
    expect(() => pipe.transform('not-an-object', { type: 'body' } as any)).toThrow(BadRequestException);
  });
});
