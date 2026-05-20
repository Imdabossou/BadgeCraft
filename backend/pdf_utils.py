import json
import io
import qrcode
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import mm
from reportlab.lib.colors import HexColor, transparent
from reportlab.lib.utils import ImageReader

def render_badge_to_pdf(c, record, b_x, b_y, elements, badge_w, badge_h, badge_bg):
    """
    Renders a single badge to a reportlab canvas.
    Units are in mm.
    """
    # Background
    if badge_bg:
        c.setFillColor(HexColor(badge_bg))
        c.rect(b_x * mm, b_y * mm, badge_w * mm, badge_h * mm, fill=1, stroke=0)

    for el in elements:
        try:
            # Common properties
            x = (b_x + el.get('x', 0)) * mm
            # ReportLab Y is from bottom, so we invert it within the badge
            y = (b_y + badge_h - el.get('y', 0) - el.get('h', 0)) * mm
            w = el.get('w', 0) * mm
            h = el.get('h', 0) * mm

            type = el.get('type')
            fill = el.get('fill', 'none')
            stroke = el.get('stroke', 'none')
            stroke_w = el.get('strokeW', 1)

            if type == 'rect':
                if fill != 'none':
                    c.setFillColor(HexColor(fill))
                if stroke != 'none':
                    c.setStrokeColor(HexColor(stroke))
                    c.setLineWidth(stroke_w)
                
                rx = el.get('rx', 0) * mm
                if rx > 0:
                    c.roundRect(x, y, w, h, rx, fill=(1 if fill != 'none' else 0), stroke=(1 if stroke != 'none' else 0))
                else:
                    c.rect(x, y, w, h, fill=(1 if fill != 'none' else 0), stroke=(1 if stroke != 'none' else 0))

            elif type == 'ellipse':
                if fill != 'none':
                    c.setFillColor(HexColor(fill))
                if stroke != 'none':
                    c.setStrokeColor(HexColor(stroke))
                    c.setLineWidth(stroke_w)
                c.ellipse(x, y, x + w, y + h, fill=(1 if fill != 'none' else 0), stroke=(1 if stroke != 'none' else 0))

            elif type == 'line':
                if stroke != 'none':
                    c.setStrokeColor(HexColor(stroke))
                    c.setLineWidth(stroke_w)
                    c.line(x, y + h/2, x + w, y + h/2)

            elif type == 'text':
                text_content = el.get('content', '')
                # Handle data variables
                for key, val in record.items():
                    text_content = text_content.replace(f'{{{{{key}}}}}', str(val))
                
                color = el.get('color', '#000000')
                font_size = el.get('fontSize', 12)
                font_family = el.get('fontFamily', 'Helvetica')
                # Map standard fonts
                if 'Serif' in font_family:
                    font_name = 'Times-Roman'
                else:
                    font_name = 'Helvetica'
                
                if el.get('bold'):
                    font_name += '-Bold'
                
                c.setFont(font_name, font_size)
                c.setFillColor(HexColor(color))
                
                align = el.get('align', 'left')
                text_y = (b_y + badge_h - el.get('y', 0)) * mm # Text baseline is different
                
                if align == 'center':
                    c.drawCentredString(x + w/2, text_y - (font_size * 0.8), text_content)
                elif align == 'right':
                    c.drawRightString(x + w, text_y - (font_size * 0.8), text_content)
                else:
                    c.drawString(x, text_y - (font_size * 0.8), text_content)

            elif type == 'qr':
                qr_data = el.get('content', '')
                for key, val in record.items():
                    qr_data = qr_data.replace(f'{{{{{key}}}}}', str(val))
                
                if qr_data:
                    qr = qrcode.QRCode(box_size=10, border=0)
                    qr.add_data(qr_data)
                    qr.make(fit=True)
                    qr_img = qr.make_image(fill_color="black", back_color="white")
                    
                    # Convert to PIL and then to ReportLab compatible
                    img_buffer = io.BytesIO()
                    qr_img.save(img_buffer, format='PNG')
                    img_buffer.seek(0)
                    c.drawImage(ImageReader(img_buffer), x, y, w, h)

            elif type == 'image':
                # For images, we might need a way to fetch them if they are URLs
                # For now, let's skip or handle base64 if possible
                pass

        except Exception as e:
            print(f"Error rendering element {el}: {e}")

def generate_bulk_pdf(design_json, attendees, output):
    """
    Generates a bulk PDF into the output stream.
    """
    state = json.loads(design_json)
    page_w = state.get('pageW', 210)
    page_h = state.get('pageH', 297)
    badge_w = state.get('badgeW', 85)
    badge_h = state.get('badgeH', 55)
    margin_top = state.get('marginTop', 10)
    margin_left = state.get('marginLeft', 10)
    gap = state.get('gap', 0)
    badge_bg = state.get('badgeBg', '#ffffff')
    elements = state.get('elements', [])

    c = canvas.Canvas(output, pagesize=(page_w * mm, page_h * mm))

    # Calculate grid
    cols = int((page_w - 2 * margin_left + gap) // (badge_w + gap))
    rows = int((page_h - 2 * margin_top + gap) // (badge_h + gap))
    
    if cols <= 0: cols = 1
    if rows <= 0: rows = 1

    badges_per_page = cols * rows
    
    for i, att in enumerate(attendees):
        if i > 0 and i % badges_per_page == 0:
            c.showPage()

        idx_on_page = i % badges_per_page
        row = idx_on_page // cols
        col = idx_on_page % cols

        b_x = margin_left + col * (badge_w + gap)
        b_y = page_h - margin_top - (row + 1) * badge_h - row * gap

        render_badge_to_pdf(c, att, b_x, b_y, elements, badge_w, badge_h, badge_bg)

    c.save()
