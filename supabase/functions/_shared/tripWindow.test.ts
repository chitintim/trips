import { assertEquals } from 'jsr:@std/assert@1'
import { addDays, boardDays, dateNote, dayHeaderLabel, isBeyondTravelWindow, placeDate, travelWindow } from './tripWindow.ts'

Deno.test('tripWindow parity: window edges', () => {
  assertEquals(travelWindow('2026-12-10', '2026-12-11'), { start: '2026-12-03', end: '2026-12-18' })
  assertEquals(placeDate('2026-12-03', '2026-12-10', '2026-12-11').place, 'before')
  assertEquals(placeDate('2026-12-02', '2026-12-10', '2026-12-11').place, 'way_before')
  assertEquals(isBeyondTravelWindow('2026-12-19', '2026-12-10', '2026-12-11'), true)
  assertEquals(addDays('2026-12-30', 3), '2027-01-02')
})

Deno.test('tripWindow parity: labels, notes and board days', () => {
  assertEquals(dayHeaderLabel('2026-12-11', '2026-12-10', '2026-12-11'), 'Day 2')
  assertEquals(dateNote('2026-12-09', '2026-12-10', '2026-12-11')?.text, 'The day before the trip starts.')
  assertEquals(boardDays(['2026-12-08', '2026-12-30'], '2026-12-10', '2026-12-11'), ['2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-30'])
})
