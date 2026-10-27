import json
import io
import qrcode
import traceback
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import mm
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.utils import ImageReader

def safe_color(color_str):
    if not color_str or color_str == 'none' or color_str == 'transparent':
        return None
    if isinstance(color_str, Color):
        return color_str
    try:
        # If it's rgb(r, g, b) format
        if color_str.startswith('rgb'):
            parts = [int(x.strip()) for x in color_str[4:-1].split(',')]
            return Color(parts[0]/255, parts[1]/255, parts[2]/255)
        return HexColor(color_str)
    except Exception:
        return None

def render_badge_to_pdf(c, record, b_x, b_y, elements, badge_w, badge_h, badge_bg):
    """
    Renders a single badge to a reportlab canvas.
    Units are in mm.
    """
    # Background
    bg = safe_color(badge_bg)
    if bg:
        c.setFillColor(bg)
        c.rect(b_x * mm, b_y * mm, badge_w * mm, badge_h * mm, fill=1, stroke=0)

    for el in elements:
        try:
            # Common properties
            x = (b_x + el.get('x', 0) / 3.7795) * mm # Convert px to mm (PX_PER_MM = 3.7795)
            y = (b_y + badge_h - (el.get('y', 0) + el.get('h', 0)) / 3.7795) * mm
            w = (el.get('w', 0) / 3.7795) * mm
            h = (el.get('h', 0) / 3.7795) * mm

            el_type = el.get('type')
            fill = safe_color(el.get('fill'))
            stroke = safe_color(el.get('stroke'))
            stroke_w = el.get('strokeW', 1)

            if el_type == 'rect':
                if fill: c.setFillColor(fill)
                if stroke:
                    c.setStrokeColor(stroke)
                    c.setLineWidth(stroke_w)
                
                rx = (el.get('rx', 0) / 3.7795) * mm
                if rx > 0:
                    c.roundRect(x, y, w, h, rx, fill=(1 if fill else 0), stroke=(1 if stroke else 0))
                else:
                    c.rect(x, y, w, h, fill=(1 if fill else 0), stroke=(1 if stroke else 0))

            elif el_type == 'ellipse':
                if fill: c.setFillColor(fill)
                if stroke:
                    c.setStrokeColor(stroke)
                    c.setLineWidth(stroke_w)
                c.ellipse(x, y, x + w, y + h, fill=(1 if fill else 0), stroke=(1 if stroke else 0))

            elif el_type == 'line':
                if stroke:
                    c.setStrokeColor(stroke)
                    c.setLineWidth(stroke_w)
                    c.line(x, y + h/2, x + w, y + h/2)

            elif el_type == 'text':
                text_content = el.get('text', '') or el.get('content', '')
                # Handle data variables
                for key, val in record.items():
                    text_content = text_content.replace(f'{{{{{key}}}}}', str(val))
                
                color = safe_color(el.get('color', '#000000'))
                font_size = el.get('fontSize', 12)
                font_family = el.get('fontFamily', 'Helvetica')
                
                # Map standard fonts
                font_name = 'Helvetica'
                if 'Serif' in font_family or 'Times' in font_family:
                    font_name = 'Times-Roman'
                
                if el.get('fontWeight') == 'bold' or el.get('bold'):
                    font_name += '-Bold'
                
                c.setFont(font_name, font_size)
                if color: c.setFillColor(color)
                
                align = el.get('align', 'left')
                # Text baseline adjustment
                text_y = (b_y + badge_h - el.get('y', 0) / 3.7795) * mm 
                
                if align == 'center':
                    c.drawCentredString(x + w/2, text_y - (font_size * 0.3), text_content)
                elif align == 'right':
                    c.drawRightString(x + w, text_y - (font_size * 0.3), text_content)
                else:
                    c.drawString(x, text_y - (font_size * 0.3), text_content)

            elif el_type == 'qr':
                qr_data = el.get('qrData', '') or el.get('content', '')
                if not qr_data and el.get('mappings'):
                    # Basic vCard generation if mappings present
                    m = el.get('mappings')
                    fn = " ".join([str(record.get(m.get('firstName', ''), '')), str(record.get(m.get('lastName', ''), ''))]).strip()
                    lines = ['BEGIN:VCARD', 'VERSION:3.0']
                    if fn: lines.append(f'FN:{fn}')
                    if record.get(m.get('org', '')): lines.append(f"ORG:{record.get(m.get('org', ''))}")
                    if record.get(m.get('email', '')): lines.append(f"EMAIL:{record.get(m.get('email', ''))}")
                    lines.append('END:VCARD')
                    qr_data = "\n".join(lines)
                else:
                    for key, val in record.items():
                        qr_data = qr_data.replace(f'{{{{{key}}}}}', str(val))
                
                if qr_data:
                    qr = qrcode.QRCode(box_size=10, border=0)
                    qr.add_data(qr_data)
                    qr.make(fit=True)
                    qr_img = qr.make_image(fill_color="black", back_color="white")
                    
                    img_buffer = io.BytesIO()
                    qr_img.save(img_buffer, format='PNG')
                    img_buffer.seek(0)
                    c.drawImage(ImageReader(img_buffer), x, y, w, h)

        except Exception:
            print(f"Error rendering element: {traceback.format_exc()}")

def generate_bulk_pdf(design_json, attendees, output):
    """
    Generates a bulk PDF into the output stream.
    """
    try:
        state = json.loads(design_json)
        page_w = state.get('pageW', 210)
        page_h = state.get('pageH', 297)
        badge_w = state.get('badgeW', 85)
        badge_h = state.get('badgeH', 55)
        margin_top = state.get('marginTop', 10)
        margin_left = state.get('marginLeft', 10)
        gap = state.get('gap', 0)
        badge_bg = state.get('badgeBg', '#ffffff')
        
        duplex = state.get('duplex', False)
        
        designs = state.get('designs', {})
        front_elements = designs.get('front', []) or state.get('elements', [])
        back_elements = designs.get('back', [])

        c = canvas.Canvas(output, pagesize=(page_w * mm, page_h * mm))

        # Calculate grid
        cols = int(state.get('cols', 1))
        rows = int(state.get('rows', 1))
        
        bpp = cols * rows # badges per page
        
        if not duplex:
            # Single sided
            for i, att in enumerate(attendees):
                if i > 0 and i % bpp == 0:
                    c.showPage()

                idx_on_page = i % bpp
                row = idx_on_page // cols
                col = idx_on_page % cols

                b_x = margin_left + col * (badge_w + gap)
                b_y = page_h - margin_top - (row + 1) * badge_h - row * gap

                render_badge_to_pdf(c, att, b_x, b_y, front_elements, badge_w, badge_h, badge_bg)
        else:
            # Duplex - logic matches frontend getSlotInfo
            # Each attendee takes 2 slots (Front, Back)
            total_slots = len(attendees) * 2
            for i in range(total_slots):
                if i > 0 and i % bpp == 0:
                    c.showPage()
                
                page_idx = i // bpp
                local_idx = i % bpp
                
                # Determine record and side
                record_idx = page_idx * (bpp // 2) + (local_idx // 2)
                if record_idx >= len(attendees):
                    continue
                    
                is_back = (local_idx % 2 == 1)
                att = attendees[record_idx]
                elements = back_elements if is_back else front_elements
                
                row = local_idx // cols
                col = local_idx % cols
                
                b_x = margin_left + col * (badge_w + gap)
                b_y = page_h - margin_top - (row + 1) * badge_h - row * gap
                
                render_badge_to_pdf(c, att, b_x, b_y, elements, badge_w, badge_h, badge_bg)

        c.save()
    except Exception:
        print(f"Bulk PDF generation error: {traceback.format_exc()}")
        raise
