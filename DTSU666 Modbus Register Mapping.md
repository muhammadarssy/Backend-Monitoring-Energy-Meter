# DTSU666 Modbus Register Mapping for UI Dashboard

## Device Information

| Label         | Register | Type  | Unit | Description             |
| ------------- | -------- | ----- | ---- | ----------------------- |
| Meter Address | 0x002D   | Int16 | -    | Slave ID                |
| Baud Rate     | 0x002E   | Int16 | bps  | Communication baud rate |
| Meter Type    | 0x000B   | Int16 | -    | Meter type              |
| Network Mode  | 0x0003   | Int16 | -    | 0 = 3P4W, 1 = 3P3W      |
| Year          | 0x0034   | Int16 | -    | RTC Year                |
| Month         | 0x0033   | Int16 | -    | RTC Month               |
| Day           | 0x0032   | Int16 | -    | RTC Day                 |
| Hour          | 0x0031   | Int16 | -    | RTC Hour                |
| Minute        | 0x0030   | Int16 | -    | RTC Minute              |
| Second        | 0x002F   | Int16 | -    | RTC Second              |

---

## Voltage Monitoring

### Phase to Neutral Voltage

| Label | Register | Unit |
| ----- | -------- | ---- |
| Ua    | 0x2006   | V    |
| Ub    | 0x2008   | V    |
| Uc    | 0x200A   | V    |

### Line to Line Voltage

| Label | Register | Unit |
| ----- | -------- | ---- |
| Uab   | 0x2000   | V    |
| Ubc   | 0x2002   | V    |
| Uca   | 0x2004   | V    |

---

## Current Monitoring

| Label | Register | Unit |
| ----- | -------- | ---- |
| Ia    | 0x200C   | A    |
| Ib    | 0x200E   | A    |
| Ic    | 0x2010   | A    |

---

## Active Power Monitoring

| Label                     | Register | Unit |
| ------------------------- | -------- | ---- |
| Total Active Power (Pt)   | 0x2012   | W    |
| Phase A Active Power (Pa) | 0x2014   | W    |
| Phase B Active Power (Pb) | 0x2016   | W    |
| Phase C Active Power (Pc) | 0x2018   | W    |

---

## Reactive Power Monitoring

| Label                       | Register | Unit |
| --------------------------- | -------- | ---- |
| Total Reactive Power (Qt)   | 0x201A   | var  |
| Phase A Reactive Power (Qa) | 0x201C   | var  |
| Phase B Reactive Power (Qb) | 0x201E   | var  |
| Phase C Reactive Power (Qc) | 0x2020   | var  |

---

## Power Factor Monitoring

| Label                    | Register | Unit |
| ------------------------ | -------- | ---- |
| Total Power Factor (PFt) | 0x202A   | -    |
| Power Factor A (PFa)     | 0x202C   | -    |
| Power Factor B (PFb)     | 0x202E   | -    |
| Power Factor C (PFc)     | 0x2030   | -    |

---

## Frequency & Demand

| Label               | Register | Unit |
| ------------------- | -------- | ---- |
| Frequency           | 0x2044   | Hz   |
| Active Power Demand | 0x2050   | W    |

---

## Energy Monitoring

### Active Energy

| Label                        | Register | Unit |
| ---------------------------- | -------- | ---- |
| Import Active Energy (ImpEp) | 0x401E   | kWh  |
| Export Active Energy (ExpEp) | 0x4028   | kWh  |

### Reactive Energy

| Label                               | Register | Unit  |
| ----------------------------------- | -------- | ----- |
| Quadrant I Reactive Energy (Q1Eq)   | 0x4032   | kvarh |
| Quadrant II Reactive Energy (Q2Eq)  | 0x403C   | kvarh |
| Quadrant III Reactive Energy (Q3Eq) | 0x4046   | kvarh |
| Quadrant IV Reactive Energy (Q4Eq)  | 0x4050   | kvarh |

---

## Data Format

### Floating Point Registers

Most electrical measurements use:

* Data Type: Float32
* Length: 2 Registers
* Byte Order: Floating Inverse (AB CD)
* Register Count: 2

Example:

| Parameter | Address         |
| --------- | --------------- |
| Ua        | 0x2006 - 0x2007 |
| Pt        | 0x2012 - 0x2013 |
| Frequency | 0x2044 - 0x2045 |

---

# Recommended Dashboard Layout

## Summary Section

* Total Active Power (Pt)
* Import Energy (ImpEp)
* Frequency
* Total Power Factor (PFt)

## Voltage Section

* Ua
* Ub
* Uc
* Uab
* Ubc
* Uca

## Current Section

* Ia
* Ib
* Ic

## Active Power Section

* Pt
* Pa
* Pb
* Pc

## Reactive Power Section

* Qt
* Qa
* Qb
* Qc

## Power Factor Section

* PFt
* PFa
* PFb
* PFc

## Energy Section

* Import Energy
* Export Energy
* Q1 Energy
* Q2 Energy
* Q3 Energy
* Q4 Energy

## Device Information Section

* Slave ID
* Baud Rate
* Meter Type
* Network Mode
* Device Time

## Wireframe UI

[ Header ]
DTSU666 Meter Monitoring | Slave ID | Baudrate | Status Connection | Last Update

[ Summary Cards ]
Total Active Power | Total Energy Import | Frequency | Power Factor

[ Voltage Section ]
Ua | Ub | Uc
Uab | Ubc | Uca

[ Current Section ]
Ia | Ib | Ic

[ Power Section ]
Pt | Pa | Pb | Pc
Qt | Qa | Qb | Qc

[ Energy Section ]
ImpEp | ExpEp
Q1Eq | Q2Eq | Q3Eq | Q4Eq

[ Device Info ]
Meter Type | Network Mode | Baudrate | Address
