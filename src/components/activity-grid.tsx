"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Task } from "@/lib/model";
import { completionDay, localDate, parseDay, shiftDay, friendlyDay } from "@/lib/dates";

export default function ActivityGrid({ tasks, weekStartsOn, onDay }: { tasks: Task[]; weekStartsOn: 0 | 1; onDay: (day: string) => void }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const today = localDate();
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of tasks) if (task.completedAt) { const day = completionDay(task.completedAt); map.set(day, (map.get(day) ?? 0) + 1); }
    return map;
  }, [tasks]);
  const first = `${year}-01-01`;
  const offset = (parseDay(first).getDay() - weekStartsOn + 7) % 7;
  const start = shiftDay(first, -offset);
  const daysInYear = Math.round((parseDay(`${year + 1}-01-01`).getTime() - parseDay(first).getTime()) / 86400000);
  const weeks = Math.ceil((daysInYear + offset) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => shiftDay(start, index));
  const monthLabels: { name: string; week: number }[] = [];
  for (let month = 0; month < 12; month++) {
    const day = new Date(year, month, 1, 12);
    const distance = Math.round((day.getTime() - parseDay(start).getTime()) / 86400000);
    monthLabels.push({ name: day.toLocaleDateString("en-GB", { month: "short" }), week: Math.floor(distance / 7) });
  }
  const completed = tasks.filter((task) => task.completedAt && completionDay(task.completedAt).startsWith(`${year}-`)).length;
  const weekdays = weekStartsOn === 1 ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return <section className="activity-section" aria-label={`Completed work in ${year}`}>
    <div className="section-heading"><h2>Your activity</h2><div className="year-picker"><button className="icon-button" onClick={() => setYear(year - 1)} aria-label="Previous year"><ChevronLeft size={16} /></button><span>{year}</span><button className="icon-button" disabled={year >= new Date().getFullYear()} onClick={() => setYear(year + 1)} aria-label="Next year"><ChevronRight size={16} /></button></div></div>
    <div className="activity-scroll"><div className="activity-chart" style={{ "--weeks": weeks } as React.CSSProperties}>
      <div className="month-labels">{monthLabels.map((month) => <span key={month.name} style={{ gridColumn: month.week + 1 }}>{month.name}</span>)}</div>
      <div className="weekday-labels">{weekdays.map((day, index) => <span key={day}>{index % 2 === 0 ? day : ""}</span>)}</div>
      <div className="activity-cells">{cells.map((day) => {
        const count = counts.get(day) ?? 0;
        const outside = !day.startsWith(`${year}-`);
        const future = day > today;
        const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4;
        return <button key={day} className={`activity-cell level-${level}${outside ? " outside" : ""}${future ? " future" : ""}${day === today ? " current" : ""}`} disabled={outside || future} title={`${friendlyDay(day)} · ${count} task${count === 1 ? "" : "s"} completed`} aria-label={`${friendlyDay(day, { day: "numeric", month: "long", year: "numeric" })}: ${count} completed tasks`} onClick={() => onDay(day)} />;
      })}</div>
    </div></div>
    <div className="activity-caption"><span>{completed} task{completed === 1 ? "" : "s"} completed in {year}</span><div className="activity-legend"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <span key={level} className={`activity-cell level-${level}`} title={["0", "1", "2–3", "4–5", "6+"][level] + " completed tasks"} />)}<span>More</span></div></div>
  </section>;
}
