"""
CosMx PNG to DeepZoom Tile Generator

Usage:
    python make_cosmx_dzi.py --all                    # Process all PNG files
    python make_cosmx_dzi.py --slide-id SLIDE_ID      # Process single slide
    python make_cosmx_dzi.py --all --format png       # Use PNG format

Output: D:\병리\data\cosmx_tiles\{slide_id}\
"""

from pathlib import Path
from PIL import Image
import math
import argparse
import shutil

Image.MAX_IMAGE_PIXELS = None


def get_max_level(width, height):
    """Calculate maximum level for DeepZoom pyramid"""
    return math.ceil(math.log2(max(width, height)))


def get_level_dimensions(width, height, level, max_level):
    """Get image dimensions at a specific level"""
    scale = 2 ** (max_level - level)
    return max(1, math.ceil(width / scale)), max(1, math.ceil(height / scale))


def get_tile_bounds(col, row, tile_size, overlap, level_w, level_h):
    """Calculate tile bounds following DeepZoom standard"""
    grid_x = col * tile_size
    grid_y = row * tile_size
    
    x1 = grid_x - overlap if col > 0 else 0
    y1 = grid_y - overlap if row > 0 else 0
    
    cols = math.ceil(level_w / tile_size)
    rows = math.ceil(level_h / tile_size)
    
    x2 = min(grid_x + tile_size + (overlap if col < cols - 1 else 0), level_w)
    y2 = min(grid_y + tile_size + (overlap if row < rows - 1 else 0), level_h)
    
    return int(x1), int(y1), int(x2), int(y2)


def export_deepzoom(png_path, out_dir, tile_size=254, overlap=1, fmt="jpeg", quality=90):
    """
    Export PNG to DeepZoom tiles
    
    Args:
        png_path: Path to PNG file
        out_dir: Output directory for tiles
        tile_size: Tile size (default: 254)
        overlap: Tile overlap (default: 1)
        fmt: Output format - 'jpeg' or 'png' (default: jpeg)
        quality: JPEG quality 1-100 (default: 90)
    """
    out_dir = Path(out_dir)
    png_path = Path(png_path)
    
    if not png_path.exists():
        print(f"  [ERROR] PNG file not found: {png_path}")
        return False
    
    slide_id = png_path.stem
    slide_out = out_dir / slide_id
    slide_out.mkdir(parents=True, exist_ok=True)

    print(f"  Input:  {png_path.name}")
    print(f"  Output: {slide_out}")
    
    try:
        # Open image
        img = Image.open(png_path)
        width, height = img.size
        print(f"  Size:   {width} x {height}")
        
        # Calculate pyramid levels
        max_level = get_max_level(width, height)
        level_count = max_level + 1
        print(f"  Levels: {level_count}")
        
        # File extension
        file_ext = 'jpeg' if fmt == 'jpeg' else 'png'
        
        # Create DZI metadata file
        dzi_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="{tile_size}" Overlap="{overlap}" Format="{fmt}" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="{width}" Height="{height}"/>
</Image>'''
        
        dzi_path = slide_out / f"{slide_id}.dzi"
        dzi_path.write_text(dzi_content, encoding="utf-8")
        
        # Create tiles directory (remove old if exists)
        files_dir = slide_out / f"{slide_id}_files"
        if files_dir.exists():
            shutil.rmtree(files_dir)
        files_dir.mkdir(parents=True, exist_ok=True)
        
        # Calculate total tiles
        total_tiles = 0
        level_info = []
        for level in range(level_count):
            level_w, level_h = get_level_dimensions(width, height, level, max_level)
            cols = math.ceil(level_w / tile_size)
            rows = math.ceil(level_h / tile_size)
            level_info.append((level, level_w, level_h, cols, rows))
            total_tiles += cols * rows
        
        print(f"  Tiles:  {total_tiles:,}")
        
        # Generate tiles
        tiles_generated = 0
        
        for level, level_w, level_h, cols, rows in level_info:
            level_dir = files_dir / str(level)
            level_dir.mkdir(parents=True, exist_ok=True)
            
            # Scale image for this level
            if level_w == width and level_h == height:
                scaled_img = img
            else:
                scaled_img = img.resize((level_w, level_h), Image.Resampling.LANCZOS)
            
            for col in range(cols):
                for row in range(rows):
                    try:
                        x1, y1, x2, y2 = get_tile_bounds(
                            col, row, tile_size, overlap, level_w, level_h
                        )
                        
                        if x2 <= x1 or y2 <= y1:
                            continue
                        
                        tile = scaled_img.crop((x1, y1, x2, y2))
                        tile_path = level_dir / f"{col}_{row}.{file_ext}"
                        
                        if fmt == 'jpeg':
                            # Convert RGBA to RGB for JPEG
                            if tile.mode == 'RGBA':
                                bg = Image.new('RGB', tile.size, (255, 255, 255))
                                bg.paste(tile, mask=tile.split()[3])
                                tile = bg
                            elif tile.mode != 'RGB':
                                tile = tile.convert('RGB')
                            tile.save(tile_path, format='JPEG', quality=quality, optimize=True)
                        else:
                            tile.save(tile_path, format='PNG', compress_level=6)
                        
                        tiles_generated += 1
                        
                        if tiles_generated % 500 == 0:
                            progress = (tiles_generated / total_tiles) * 100
                            print(f"  Progress: {progress:.1f}%", end='\r')
                    
                    except Exception as e:
                        continue
            
            # Free memory
            if scaled_img is not img:
                scaled_img.close()
        
        print(f"  ✓ Done: {tiles_generated:,} tiles          ")
        
        img.close()
        return True
        
    except Exception as e:
        print(f"  [ERROR] {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    parser = argparse.ArgumentParser(description='CosMx PNG to DeepZoom Tiles')
    parser.add_argument('--slide-id', type=str, help='Single slide ID')
    parser.add_argument('--all', action='store_true', help='Process all PNG files')
    parser.add_argument('--cosmx-dir', type=str, default=r'D:\병리\data\cosmx', help='CosMx PNG directory')
    parser.add_argument('--output-dir', type=str, default=r'D:\병리\data\cosmx_tiles', help='Output directory')
    parser.add_argument('--format', type=str, default='jpeg', choices=['jpeg', 'png'], help='Tile format')
    parser.add_argument('--quality', type=int, default=90, help='JPEG quality (1-100)')
    parser.add_argument('--tile-size', type=int, default=254, help='Tile size')
    
    args = parser.parse_args()
    
    cosmx_dir = Path(args.cosmx_dir)
    output_dir = Path(args.output_dir)
    
    print("=" * 60)
    print("CosMx PNG to DeepZoom Tile Generator")
    print("=" * 60)
    print(f"Input:  {cosmx_dir}")
    print(f"Output: {output_dir}")
    print(f"Format: {args.format}")
    print()
    
    if args.all:
        # Batch mode - process all PNG files
        png_files = sorted(cosmx_dir.glob("*.png"))
        
        if not png_files:
            print(f"[ERROR] No PNG files found in {cosmx_dir}")
            return
        
        print(f"Found {len(png_files)} PNG files")
        print("=" * 60)
        
        success = 0
        failed = 0
        
        for i, png_file in enumerate(png_files, 1):
            print(f"\n[{i}/{len(png_files)}] {png_file.stem}")
            
            if export_deepzoom(png_file, output_dir,
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
        png_path = cosmx_dir / f"{args.slide_id}.png"
        
        if not png_path.exists():
            print(f"[ERROR] PNG file not found: {png_path}")
            return
        
        print(f"Processing: {args.slide_id}")
        print("=" * 60)
        
        if export_deepzoom(png_path, output_dir,
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