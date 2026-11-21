import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Journal and inbox writes wait for fsync. A test that makes hundreds of them to check paging or bounds, not
// durability, can pass CI's 2-minute budget for its file on a host where one fsync takes 70 ms. Such tests keep their
// files in RAM-backed storage where the host has it; tests of sync ordering and crash recovery keep the real disk.
export const bulkTempRoot = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
