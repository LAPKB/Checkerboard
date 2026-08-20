import { LazyStore } from "@tauri-apps/plugin-store";

export interface PlotColors {
  low: string;
  midpoint: string;
  high: string;
  expected: string;
}

export const defaultPlotColors: PlotColors = {
  low: "#00a83b",
  midpoint: "#ffffff",
  high: "#ff2b20",
  expected: "#2458a6",
};

const preferences = new LazyStore("checkerboard-preferences.json", {
  defaults: { plotColors: defaultPlotColors },
  autoSave: 150,
});

export async function loadPlotColors(): Promise<PlotColors> {
  const stored = await preferences.get<Partial<PlotColors>>("plotColors");
  return { ...defaultPlotColors, ...stored };
}

export async function savePlotColors(colors: PlotColors): Promise<void> {
  await preferences.set("plotColors", colors);
  await preferences.save();
}
