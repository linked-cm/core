---
"@_linked/core": minor
---

`xsd:time` properties take a pattern-checked **string**, written as a typed literal.

**Breaking for `xsd:time` only:** a `Date` on an `xsd:time` property is now rejected. `xsd:date` and `xsd:dateTime` are unchanged and still take a `Date` and only a `Date`.

A time of day is not an instant. Using `Date` for one means inventing a date to carry it: the date half is meaningless, is discarded during serialisation anyway, and makes two identical clock times recorded on different days compare unequal. JavaScript has no time-only type — `Temporal.PlainTime` is the right answer and is not yet available — so the lexical form is the honest representation.

```ts
@literalProperty({path: schedule.startsAt, datatype: xsd.time, maxCount: 1})
get startsAt(): string { return ''; }

Appointment.create({startsAt: '14:30:00'});
// <…> <…#startsAt> "14:30:00"^^xsd:time .
```

Accepted: `HH:MM:SS`, optional milliseconds, optional `Z` or `±HH:MM` offset — `'14:30:00'`, `'14:30:00.250'`, `'14:30:00Z'`, `'14:30:00.250+02:00'`. Ranges are enforced *by the pattern* (hours `00-23`, minutes and seconds `00-59`), so `'25:00:00'` is rejected rather than written as a malformed literal that no engine will match — a failure that otherwise surfaces as "the data is simply missing". The optional timezone is accepted because it is valid `xsd:time`; rejecting `'14:30:00Z'` would make the check stricter than the datatype it validates.

**The serialisation half matters as much as the validation.** Mutation literals are typed from the *JavaScript* type when they reach SPARQL, so a plain string would be written as a plain literal and silently stop matching the property it was meant to fill. A string on an `xsd:time` property is now typed from the **declared** datatype instead.

That behaviour is driven by an explicit allow-list rather than "type every string from whatever is declared". A string reaching a numeric or boolean property is a mistake `assertValid` rejects; typing it from the declaration would instead write a plausible-looking `"abc"^^xsd:integer` and hide the error in the data. Only datatypes for which a string is a valid lexical form belong in the list.
