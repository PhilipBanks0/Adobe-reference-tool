"""Generate samples/sample-workpaper.pdf and samples/updated-bank-statement.pdf
for trying the Reference Tool. Run: python3 samples/make_sample.py"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def table(c, x, y, rows, bold_last=True):
    for i, (label, amt) in enumerate(rows):
        font = "Helvetica-Bold" if bold_last and i == len(rows) - 1 else "Helvetica"
        c.setFont(font, 10)
        c.drawString(x, y, label)
        c.drawRightString(x + 380, y, amt)
        y -= 18
    return y


def header(c, title, sub):
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 720, title)
    c.setFont("Helvetica", 10)
    c.drawString(72, 704, sub)
    c.line(72, 696, 540, 696)


def workpaper():
    c = canvas.Canvas(os.path.join(HERE, "sample-workpaper.pdf"), pagesize=letter)
    header(c, "Sample Co. - Balance Sheet", "As at December 31, 2025 (unaudited)")
    table(c, 72, 670, [
        ("Cash", "14,850.00"),
        ("Accounts receivable", "42,310.00"),
        ("Prepaid expenses", "3,600.00"),
        ("Total current assets", "60,760.00"),
    ])
    c.showPage()

    header(c, "Bank Statement - Operating Account", "Statement period Dec 1 - Dec 31, 2025")
    table(c, 72, 670, [
        ("Opening balance", "10,120.00"),
        ("Deposits", "25,480.00"),
        ("Withdrawals", "(23,200.00)"),
        ("Closing balance", "12,400.00"),
    ])
    c.showPage()

    header(c, "Bank Reconciliation", "December 31, 2025")
    table(c, 72, 670, [
        ("Balance per bank", "12,400.00"),
        ("Add: deposits in transit", "3,250.00"),
        ("Less: outstanding cheques", "(800.00)"),
        ("Balance per books", "14,850.00"),
    ])
    c.showPage()

    header(c, "AR Aging Summary", "December 31, 2025")
    table(c, 72, 670, [
        ("Current", "30,110.00"),
        ("31-60 days", "8,900.00"),
        ("61-90 days", "3,300.00"),
        ("Total", "42,310.00"),
    ])
    c.showPage()
    c.save()


def updated_statement():
    c = canvas.Canvas(os.path.join(HERE, "updated-bank-statement.pdf"), pagesize=letter)
    header(c, "Bank Statement - Operating Account (REVISED)", "Statement period Dec 1 - Dec 31, 2025")
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(72, 684, "Reissued by the bank on Jan 15, 2026")
    table(c, 72, 650, [
        ("Opening balance", "10,120.00"),
        ("Deposits", "25,480.00"),
        ("Withdrawals", "(23,200.00)"),
        ("Closing balance", "12,400.00"),
    ])
    c.showPage()
    c.save()


if __name__ == "__main__":
    workpaper()
    updated_statement()
    print("Wrote sample-workpaper.pdf and updated-bank-statement.pdf")
