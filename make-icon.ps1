$ErrorActionPreference = 'Stop'
# Draw a 128x128 extension icon locally: blue gradient rounded background + white calendar + green check badge
# NOTE: keep this file ASCII-only; non-ASCII comments break Add-Type compilation encoding
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

public static class IconMaker
{
    public static void Render(string outPath)
    {
        int size = 128;
        using (var bmp = new Bitmap(size, size))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;

            // rounded background path
            var path = new GraphicsPath();
            int r = 24;
            path.AddArc(0, 0, 2*r, 2*r, 180, 90);
            path.AddArc(size-2*r, 0, 2*r, 2*r, 270, 90);
            path.AddArc(size-2*r, size-2*r, 2*r, 2*r, 0, 90);
            path.AddArc(0, size-2*r, 2*r, 2*r, 90, 90);
            path.CloseFigure();

            // background: deep blue gradient
            using (var brush = new LinearGradientBrush(new Rectangle(0, 0, size, size),
                Color.FromArgb(255, 30, 60, 140), Color.FromArgb(255, 60, 120, 220),
                LinearGradientMode.Vertical))
            {
                g.FillPath(brush, path);
            }

            // calendar body (white)
            g.FillRectangle(Brushes.White, 30, 38, 68, 60);

            // calendar header (red)
            using (var red = new SolidBrush(Color.FromArgb(255, 230, 80, 80)))
                g.FillRectangle(red, 30, 38, 68, 16);

            // calendar rings
            using (var ring = new SolidBrush(Color.FromArgb(255, 70, 90, 120)))
            {
                g.FillRectangle(ring, 42, 30, 8, 14);
                g.FillRectangle(ring, 78, 30, 8, 14);
            }

            // date cells (light gray)
            using (var dot = new SolidBrush(Color.FromArgb(255, 200, 210, 225)))
            {
                for (int row = 0; row < 3; row++)
                    for (int col = 0; col < 4; col++)
                        g.FillRectangle(dot, 40 + col*14, 62 + row*11, 8, 6);
            }

            // green check badge (bottom-right)
            using (var badge = new SolidBrush(Color.FromArgb(255, 40, 180, 100)))
                g.FillEllipse(badge, 74, 74, 44, 44);
            using (var pen = new Pen(Color.White, 7))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawLine(pen, 84, 97, 93, 106);
                g.DrawLine(pen, 93, 106, 110, 86);
            }

            bmp.Save(outPath, ImageFormat.Png);
        }
    }
}
"@
[IconMaker]::Render((Join-Path $PSScriptRoot 'icon.png'))
Write-Output 'icon.png created'
