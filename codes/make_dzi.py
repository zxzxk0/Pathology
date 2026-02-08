"""
SVS to DeepZoom Tile Generator

Usage:
    python make_dzi.py --all                    # Process all SVS files
    python make_dzi.py --slide-id SLIDE_ID      # Process single slide
    python make_dzi.py --slide-id SLIDE_ID --format png  # Use PNG format

Output: D:\병리\data\tiles\{slide_id}\
"""

from pathlib import Path
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
import argparse
import sys


def export_deepzoom(svs_path, out_dir, tile_size=254, overlap=1, fmt="jpeg", quality=90):
    """
    Export SVS to DeepZoom tiles
    
    Args:
        svs_path: Path to SVS file
        out_dir: Output directory for tiles
        tile_size: Tile size (default: 254)
        overlap: Tile overlap (default: 1)
        fmt: Output format - 'jpeg' or 'png' (default: jpeg)
        quality: JPEG quality 1-100 (default: 90)
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    
    svs_path = Path(svs_path)
    if not svs_path.exists():
        print(f"  [ERROR] SVS file not found: {svs_path}")
        return False
    
    slide_id = svs_path.stem
    slide_out = out_dir / slide_id
    slide_out.mkdir(parents=True, exist_ok=True)

    print(f"  Input:  {svs_path.name}")
    print(f"  Output: {slide_out}")
    
    try:
        # Open slide
        slide = OpenSlide(str(svs_path))
        w, h = slide.dimensions
        print(f"  Size:   {w} x {h}")
        
        # Create DeepZoom generator
        dz = DeepZoomGenerator(slide, tile_size=tile_size, overlap=overlap, limit_bounds=False)
        print(f"  Levels: {dz.level_count}")
        
        # File extension - FIXED: consistent jpeg extension
        file_ext = 'jpeg' if fmt == 'jpeg' else 'png'
        
        # Create DZI metadata file
        dzi_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="{tile_size}" Overlap="{overlap}" Format="{fmt}" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="{w}" Height="{h}"/>
</Image>'''
        
        dzi_path = slide_out / f"{slide_id}.dzi"
        dzi_path.write_text(dzi_content, encoding="utf-8")
        
        # Create tiles directory
        files_dir = slide_out / f"{slide_id}_files"
        files_dir.mkdir(parents=True, exist_ok=True)
        
        # Count total tiles for progress
        total_tiles = sum(cols * rows for cols, rows in dz.level_tiles)
        print(f"  Tiles:  {total_tiles:,}")
        
        # Generate tiles
        tiles_generated = 0
        for level in range(dz.level_count):
            level_dir = files_dir / str(level)
            level_dir.mkdir(parents=True, exist_ok=True)
            
            cols, rows = dz.level_tiles[level]
            
            for col in range(cols):
                for row in range(rows):
                    try:
                        tile = dz.get_tile(level, (col, row))
                        tile_path = level_dir / f"{col}_{row}.{file_ext}"
                        
                        if fmt == 'jpeg':
                            tile.save(tile_path, format='JPEG', quality=quality, optimize=True)
                        else:
                            tile.save(tile_path, format='PNG', compress_level=6)
                        
                        tiles_generated += 1
                        
                        if tiles_generated % 500 == 0:
                            progress = (tiles_generated / total_tiles) * 100
                            print(f"  Progress: {progress:.1f}%", end='\r')
                    
                    except Exception as e:
                        continue
        
        print(f"  ✓ Done: {tiles_generated:,} tiles          ")
        
        slide.close()
        return True
        
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description='SVS to DeepZoom Tiles')
    parser.add_argument('--slide-id', type=str, help='Single slide ID')
    parser.add_argument('--all', action='store_true', help='Process all SVS files')
    parser.add_argument('--slides-dir', type=str, default=r'D:\병리\data\slides', help='SVS directory')
    parser.add_argument('--output-dir', type=str, default=r'D:\병리\data\tiles', help='Output directory')
    parser.add_argument('--format', type=str, default='jpeg', choices=['jpeg', 'png'], help='Tile format')
    parser.add_argument('--quality', type=int, default=90, help='JPEG quality (1-100)')
    parser.add_argument('--tile-size', type=int, default=254, help='Tile size')
    
    args = parser.parse_args()
    
    slides_dir = Path(args.slides_dir)
    output_dir = Path(args.output_dir)
    
    print("=" * 60)
    print("SVS to DeepZoom Tile Generator")
    print("=" * 60)
    print(f"Input:  {slides_dir}")
    print(f"Output: {output_dir}")
    print(f"Format: {args.format}")
    print()
    
    if args.all:
        # Batch mode - process all SVS files
        svs_files = sorted(slides_dir.glob("*.svs"))
        
        if not svs_files:
            print(f"[ERROR] No SVS files found in {slides_dir}")
            return
        
        print(f"Found {len(svs_files)} SVS files")
        print("=" * 60)
        
        success = 0
        failed = 0
        
        for i, svs_file in enumerate(svs_files, 1):
            print(f"\n[{i}/{len(svs_files)}] {svs_file.stem}")
            
            if export_deepzoom(svs_file, output_dir, 
                             tile_size=args.tile_size,
                             fmt=args.format, 
                             quality=args.quality):
                success += 1
            else:
                failed += 1
        
        print()
        print("=" * 60)
        print(f"Complete: {success} success, {failed} failed")
        print("=" * 60)
        
    elif args.slide_id:
        # Single mode
        svs_path = slides_dir / f"{args.slide_id}.svs"
        
        if not svs_path.exists():
            print(f"[ERROR] SVS file not found: {svs_path}")
            return
        
        print(f"Processing: {args.slide_id}")
        print("=" * 60)
        
        if export_deepzoom(svs_path, output_dir,
                         tile_size=args.tile_size,
                         fmt=args.format,
                         quality=args.quality):
            print("\n✓ Success!")
        else:
            print("\n✗ Failed!")
    
    else:
        print("[ERROR] Use --all or --slide-id")
        parser.print_help()


if __name__ == '__main__':
    main()