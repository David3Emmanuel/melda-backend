// Auth: password hashing, JWT issue/verify, and the access middleware. This is
// what replaces the old "pick any name" impersonation - the JWT subject is the
// authenticated user id, and class access is checked against the M:N join tables
// (a teacher via class_teachers, a student via class_students; there is no direct
// student<->teacher link to check).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import type { AuthUser, Role } from 'melda-shared';
import { db } from '../db/client';
import * as t from '../db/schema';

const HASH_COST = 10;
// Ceiling: bcryptjs is pure-JS (no native build on Windows); argon2id is the
// stronger upgrade if this ever leaves the demo.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-in-production';
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, HASH_COST);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export function signToken(user: AuthUser): string {
  return jwt.sign({ role: user.role, name: user.name, email: user.email }, JWT_SECRET, {
    subject: user.id,
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

// The decoded principal rides on the request for every authed handler.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Verify a JWT and decode the principal, or throw if invalid/expired. */
export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
  return {
    id: String(payload.sub),
    role: payload.role as Role,
    name: String(payload.name ?? ''),
    email: String(payload.email ?? ''),
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: `${role}s only` });
      return;
    }
    next();
  };
}

/** Membership check via the join tables - the one place tenancy is enforced. */
export async function userInClass(user: AuthUser, classId: string): Promise<boolean> {
  const rows =
    user.role === 'teacher'
      ? await db
          .select()
          .from(t.classTeachers)
          .where(and(eq(t.classTeachers.classId, classId), eq(t.classTeachers.teacherId, user.id)))
          .limit(1)
      : await db
          .select()
          .from(t.classStudents)
          .where(and(eq(t.classStudents.classId, classId), eq(t.classStudents.studentId, user.id)))
          .limit(1);
  return rows.length > 0;
}

/** Read a path param as a string. Express 5 types params as string | string[]
 *  (repeatable segments); our routes only ever use single segments. */
export const pathParam = (req: Request, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : v;
};

/** Guards routes whose class id is a path param (default `:id`). */
export function requireClassAccess(param = 'id') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (await userInClass(req.user, pathParam(req, param))) {
      next();
      return;
    }
    res.status(403).json({ error: 'not a member of this class' });
  };
}
