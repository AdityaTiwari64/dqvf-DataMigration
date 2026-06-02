import { describe, it, expect } from 'vitest';
import { hashRow, hashChunk, hashRows, compareHashes, hashString } from '../../../src/utils/hashing.js';

describe('hashing utilities', () => {
  describe('hashRow', () => {
    it('should produce consistent hashes for same input', () => {
      const hash1 = hashRow(['foo', 42, true]);
      const hash2 = hashRow(['foo', 42, true]);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different input', () => {
      const hash1 = hashRow(['foo', 42]);
      const hash2 = hashRow(['bar', 42]);
      expect(hash1).not.toBe(hash2);
    });

    it('should handle null and undefined values', () => {
      const hash1 = hashRow([null, undefined, 'test']);
      const hash2 = hashRow([null, undefined, 'test']);
      expect(hash1).toBe(hash2);
    });

    it('should handle Date objects', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const hash = hashRow([date]);
      expect(hash).toHaveLength(32); // MD5 hex length
    });

    it('should handle objects by JSON serialization', () => {
      const hash = hashRow([{ a: 1, b: 2 }]);
      expect(hash).toHaveLength(32);
    });

    it('should support SHA-256 algorithm', () => {
      const md5 = hashRow(['test'], 'md5');
      const sha = hashRow(['test'], 'sha256');
      expect(md5).toHaveLength(32);
      expect(sha).toHaveLength(64);
    });
  });

  describe('hashChunk', () => {
    it('should produce order-independent hashes', () => {
      const hash1 = hashChunk(['aaa', 'bbb', 'ccc']);
      const hash2 = hashChunk(['ccc', 'aaa', 'bbb']);
      expect(hash1).toBe(hash2);
    });

    it('should detect different content', () => {
      const hash1 = hashChunk(['aaa', 'bbb']);
      const hash2 = hashChunk(['aaa', 'ccc']);
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty arrays', () => {
      const hash = hashChunk([]);
      expect(hash).toHaveLength(32);
    });
  });

  describe('hashRows', () => {
    it('should hash multiple rows deterministically', () => {
      const rows = [
        ['a', 1],
        ['b', 2],
      ];
      const hash1 = hashRows(rows);
      const hash2 = hashRows(rows);
      expect(hash1).toBe(hash2);
    });
  });

  describe('compareHashes', () => {
    it('should report match for identical hashes', () => {
      const result = compareHashes('abc123', 'abc123');
      expect(result.match).toBe(true);
    });

    it('should report mismatch for different hashes', () => {
      const result = compareHashes('abc123', 'def456');
      expect(result.match).toBe(false);
      expect(result.source).toBe('abc123');
      expect(result.target).toBe('def456');
    });
  });

  describe('hashString', () => {
    it('should hash a string value', () => {
      const hash = hashString('hello world');
      expect(hash).toHaveLength(32);
    });

    it('should produce consistent results', () => {
      expect(hashString('test')).toBe(hashString('test'));
    });
  });
});
