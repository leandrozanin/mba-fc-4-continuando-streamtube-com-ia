export interface ProcessVideoJob {
  videoId: string;
}

// Subset of `ffprobe -print_format json -show_format -show_streams`
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

export interface ProbeResult {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}
