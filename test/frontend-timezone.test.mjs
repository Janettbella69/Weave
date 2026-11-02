import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wallClockIn,instantFromWallClock,shouldAdoptDeviceTimezone,isValidTimezone,SERVER_DEFAULT_TIMEZONE} from '../hosted/app/workspace/timezone.mjs';

test('a wall-clock time is turned into the right instant in each zone',()=>{
  // 2026-11-02 is after the US clocks went back (Nov 1): Los Angeles is UTC-8, Shanghai UTC+8
  assert.equal(instantFromWallClock('2026-11-02T09:00','America/Los_Angeles').toISOString(),'2026-11-02T17:00:00.000Z');
  assert.equal(instantFromWallClock('2026-11-02T09:00','Asia/Shanghai').toISOString(),'2026-11-02T01:00:00.000Z');
  // summer: UTC-7
  assert.equal(instantFromWallClock('2026-07-01T09:00','America/Los_Angeles').toISOString(),'2026-07-01T16:00:00.000Z');
  assert.equal(instantFromWallClock('2026-07-01T09:00','UTC').toISOString(),'2026-07-01T09:00:00.000Z');
  assert.equal(instantFromWallClock('2026-01-01T00:00','Asia/Tokyo').toISOString(),'2025-12-31T15:00:00.000Z');
});

test('it reads back the same wall clock, including around a clock change',()=>{
  for(const zone of ['America/Los_Angeles','Asia/Shanghai','Europe/London','Asia/Kolkata','UTC']){
    for(const local of ['2026-01-15T08:05','2026-03-08T12:00','2026-03-29T12:00','2026-11-01T12:00','2026-12-31T23:59','2027-01-01T00:00']){
      assert.equal(wallClockIn(instantFromWallClock(local,zone),zone),local,zone+' '+local);
    }
  }
  // the hour after the spring-forward gap in Los Angeles (2026-03-08 02:00 does not exist)
  assert.equal(wallClockIn(instantFromWallClock('2026-03-08T03:30','America/Los_Angeles'),'America/Los_Angeles'),'2026-03-08T03:30');
});

test('midnight is 00:xx, not 24:xx',()=>{
  assert.equal(wallClockIn(Date.parse('2026-11-02T08:30:00Z'),'America/Los_Angeles'),'2026-11-02T00:30');
});

test('input that is not a time gives null',()=>{
  assert.equal(instantFromWallClock('','UTC'),null);assert.equal(instantFromWallClock('soon','UTC'),null);
});

test('the browser zone replaces the server default only for a profile nobody has saved',()=>{
  const fresh={revision:1,timezone:SERVER_DEFAULT_TIMEZONE};
  assert.equal(shouldAdoptDeviceTimezone(fresh,'America/Los_Angeles'),true);
  assert.equal(shouldAdoptDeviceTimezone(fresh,'Asia/Shanghai'),false,'already the same');
  assert.equal(shouldAdoptDeviceTimezone({revision:2,timezone:SERVER_DEFAULT_TIMEZONE},'America/Los_Angeles'),false,'profile was saved');
  assert.equal(shouldAdoptDeviceTimezone({revision:1,timezone:'Europe/London'},'America/Los_Angeles'),false,'someone chose a zone');
  assert.equal(shouldAdoptDeviceTimezone(fresh,''),false);assert.equal(shouldAdoptDeviceTimezone(fresh,'Not/AZone'),false);
  assert.equal(shouldAdoptDeviceTimezone(null,'America/Los_Angeles'),false);
  assert.equal(isValidTimezone('America/Los_Angeles'),true);assert.equal(isValidTimezone('nope'),false);assert.equal(isValidTimezone(undefined),false);
});
